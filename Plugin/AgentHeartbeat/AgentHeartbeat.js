const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const lockfile = require('proper-lockfile');

const ROOT = __dirname;
const BLOCKED_TOOLS = new Set(['AgentAssistant', 'AgentHeartbeat', 'AgentMessage']);
const DEFAULTS = { enabled: false, interval: 30, start: '08:00', end: '23:00', maxRun: 600, maxSummary: 1200, maxNotification: 1200, retry: 5, maxFailures: 3, history: 100 };
let cfg = { ...DEFAULTS, agents: {} };
let deps = {};
let timers = new Map();
let states = new Map();
let running = new Set();
let queued = new Set();
let stopping = false;
let injectedConfig = {};

const bool = v => String(v).toLowerCase() === 'true';
const clamp = (v, min, max, fallback) => Math.min(max, Math.max(min, Number.isFinite(Number(v)) ? Number(v) : fallback));
const trim = (v, n) => String(v || '').replace(/```[\s\S]*?```/g, '').trim().slice(0, n);
const hash = v => crypto.createHash('sha256').update(v).digest('hex');
const atomicWrite = async (file, value) => { const tmp = `${file}.tmp-${process.pid}-${Date.now()}`; await fsp.writeFile(tmp, JSON.stringify(value, null, 2)); await fsp.rename(tmp, file); };
const validTime = v => /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
const parseMinutes = v => { const [h, m] = v.split(':').map(Number); return h * 60 + m; };
const isChecklistEmpty = value => !String(value || '').replace(/^\s*#.*$/gm, '').replace(/<!--[\s\S]*?-->/g, '').trim();
function zonedMinutes(date, timezone) { try { const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date); return Number(parts.find(x => x.type === 'hour').value) * 60 + Number(parts.find(x => x.type === 'minute').value); } catch (_) { return date.getHours() * 60 + date.getMinutes(); } }
function inActive(agent, now = new Date()) {
  const active = agent.activeHours || {};
  if (!validTime(active.start) || !validTime(active.end)) return true;
  const value = zonedMinutes(now, active.timezone);
  const start = parseMinutes(active.start), end = parseMinutes(active.end);
  return start <= end ? value >= start && value < end : value >= start || value < end;
}
function nextActive(agent, from = new Date()) {
  const active = agent.activeHours || {};
  if (!validTime(active.start) || !validTime(active.end)) return from;
  if (inActive(agent, from)) return from;
  const d = new Date(from); d.setSeconds(0, 0);
  for (let i = 1; i <= 1441; i++) { d.setMinutes(d.getMinutes() + 1); if (inActive(agent, d)) return d; }
  return from;
}
function stateFor(name) { return states.get(name) || { version: 1, agentName: name, lastRunAt: null, lastStatus: 'never', lastError: null, lastSummary: '', lastNotificationHash: null, lastNotificationAt: null, consecutiveFailures: 0, nextDueAt: null, pendingDelivery: null, runs: [] }; }
async function loadState(name) {
  const file = path.join(cfg.stateDir, `${name}.json`);
  try { states.set(name, { ...stateFor(name), ...JSON.parse(await fsp.readFile(file, 'utf8')) }); }
  catch (e) { if (e.code !== 'ENOENT') { try { await fsp.rename(file, `${file}.corrupt.${Date.now()}`); } catch (_) {} } states.set(name, stateFor(name)); }
}
async function saveState(name) { await fsp.mkdir(cfg.stateDir, { recursive: true }); await atomicWrite(path.join(cfg.stateDir, `${name}.json`), stateFor(name)); }
function readPluginConfig() {
  let json = {}; try { json = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch (_) {}
  const e = k => injectedConfig[k] ?? process.env[k];
  cfg = { ...DEFAULTS, enabled: bool(e('HEARTBEAT_ENABLED') ?? DEFAULTS.enabled), interval: clamp(e('HEARTBEAT_DEFAULT_INTERVAL_MINUTES'), 5, 1440, 30), start: e('HEARTBEAT_DEFAULT_ACTIVE_START') || DEFAULTS.start, end: e('HEARTBEAT_DEFAULT_ACTIVE_END') || DEFAULTS.end, maxRun: clamp(e('HEARTBEAT_MAX_RUN_SECONDS'), 1, 86400, 600), maxSummary: clamp(e('HEARTBEAT_MAX_SUMMARY_CHARS'), 100, 10000, 1200), maxNotification: clamp(e('HEARTBEAT_MAX_NOTIFICATION_CHARS'), 100, 10000, 1200), retry: clamp(e('HEARTBEAT_RETRY_MINUTES'), 1, 1440, 5), maxFailures: clamp(e('HEARTBEAT_MAX_CONSECUTIVE_FAILURES'), 1, 100, 3), history: clamp(e('HEARTBEAT_RUN_HISTORY_LIMIT'), 1, 1000, 100), stateDir: path.resolve(ROOT, e('HEARTBEAT_STATE_DIR') || 'state'), agents: {} };
  for (const [name, raw] of Object.entries(json.agents || {})) cfg.agents[name] = normalizeAgent(raw);
}
function normalizeAgent(raw = {}) { return { enabled: raw.enabled !== false, heartbeatFile: raw.heartbeatFile || '', intervalMinutes: clamp(raw.intervalMinutes, 5, 1440, cfg.interval), activeHours: { start: raw.activeHours?.start || cfg.start, end: raw.activeHours?.end || cfg.end, timezone: raw.activeHours?.timezone || 'Asia/Shanghai' }, allowedTools: [...new Set((raw.allowedTools || []).filter(t => /^[A-Za-z0-9_-]+$/.test(t) && !BLOCKED_TOOLS.has(t)))], maxNotificationsPerRun: 1 }; }
function schedule(name, delay) { if (timers.has(name)) clearTimeout(timers.get(name)); if (stopping || !cfg.enabled || !cfg.agents[name]?.enabled) return; const t = setTimeout(() => run(name, 'interval').catch(() => {}), Math.max(0, delay)); t.unref?.(); timers.set(name, t); }
function scheduleNext(name, minutes) { const agent = cfg.agents[name]; if (!agent) return; const when = nextActive(agent, new Date(Date.now() + minutes * 60000)); stateFor(name).nextDueAt = when.toISOString(); saveState(name).catch(() => {}); schedule(name, Math.max(0, when.getTime() - Date.now())); }
async function run(name, reason = 'interval', force = false, requestedRunId = null) {
  queued.delete(name);
  if (stopping || running.has(name)) { stateFor(name).lastStatus = 'skipped_busy'; await saveState(name); return { status: 'skipped_busy' }; }
  const agent = cfg.agents[name]; if (!agent || !cfg.enabled || (!agent.enabled && !force)) return { status: 'disabled' };
  if (!force && !inActive(agent)) { scheduleNext(name, 0); return { status: 'outside_active' }; }
  const assistant = deps.pluginManager?.getServiceModule('AgentAssistant'); if (!assistant) throw new Error('AgentAssistant service unavailable');
  const runId = requestedRunId || `hb-${Date.now()}-${hash(name).slice(0, 6)}`, started = Date.now(); running.add(name); let release;
  const state = stateFor(name); state.lastRunAt = new Date(started).toISOString();
  try {
    await fsp.mkdir(cfg.stateDir, { recursive: true }); const lock = path.join(cfg.stateDir, `.${name}.run.lock`); await fsp.appendFile(lock, ''); release = await lockfile.lock(lock, { retries: 0, stale: cfg.maxRun * 1000, realpath: false });
    if (state.pendingDelivery?.message) {
      try {
        await deps.pluginManager.processToolCall('AgentMessage', { Maid: name, message: state.pendingDelivery.message });
      } catch (error) {
        error.deliveryFailure = true;
        throw error;
      }
      state.lastNotificationHash = state.pendingDelivery.hash;
      state.lastNotificationAt = new Date().toISOString();
      state.lastSummary = state.pendingDelivery.message;
      state.pendingDelivery = null;
      state.lastStatus = 'notified';
      state.consecutiveFailures = 0;
      state.lastError = null;
    } else {
    const file = path.resolve(ROOT, agent.heartbeatFile); const root = path.resolve(ROOT, 'heartbeats'); if (!file.startsWith(root + path.sep)) throw new Error('Invalid heartbeat file path');
    let checklist = ''; try { checklist = await fsp.readFile(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (isChecklistEmpty(checklist)) { state.lastStatus = 'skipped_empty'; state.lastSummary = ''; }
    else {
      const prompt = `你正在执行一次系统心跳巡检。\n读取指定的心跳清单，并严格按清单检查。只能使用本次提供的工具。不要重复已经在历史摘要中确认过的事项。如果没有需要用户知道或处理的事情，只回复 HEARTBEAT_OK。如果有事项，只输出一条简洁、可执行的提醒，不要解释心跳机制。不要调用 AgentAssistant、AgentHeartbeat 或 AgentMessage。\n\n心跳清单：\n${checklist}\n\n最近摘要：${state.lastSummary || '[无]'}\n当前时间：${new Date().toISOString()}\n运行 ID：${runId}\n允许工具：${agent.allowedTools.join(', ') || '[无]'}`;
      const result = await Promise.race([assistant.processToolCall({ agent_name: name, prompt, maid: '系统心跳', temporary_contact: true, session_id: `heartbeat:${name}`, inject_tools: agent.allowedTools.join(',') }), new Promise((_, reject) => setTimeout(() => reject(new Error('heartbeat timeout')), cfg.maxRun * 1000))]);
      const text = trim(result?.content?.find(x => x.type === 'text')?.text || result?.result || result, cfg.maxSummary); state.lastSummary = text; const normalized = text.replace(/^\s*[`*_#-]*\s*HEARTBEAT_OK\s*[`*_#-]*\s*$/i, '').trim();
      if (!normalized || /^HEARTBEAT_OK$/i.test(text.trim())) state.lastStatus = 'ok_noop';
      else if (state.lastNotificationHash === hash(normalized)) state.lastStatus = 'deduped';
      else { const message = trim(normalized, cfg.maxNotification); try { await deps.pluginManager.processToolCall('AgentMessage', { Maid: name, message }); } catch (error) { state.pendingDelivery = { message, hash: hash(normalized), failedAt: new Date().toISOString() }; error.deliveryFailure = true; throw error; } state.lastNotificationHash = hash(normalized); state.lastNotificationAt = new Date().toISOString(); state.pendingDelivery = null; state.lastStatus = 'notified'; }
      state.consecutiveFailures = 0; state.lastError = null;
    }
    }
  } catch (e) { state.lastStatus = e.code === 'ELOCKED' ? 'skipped_busy' : (e.deliveryFailure ? 'delivery_failed' : 'failed'); state.lastError = String(e.message || e).slice(0, 500); state.consecutiveFailures++; if (state.consecutiveFailures >= cfg.maxFailures) { if (cfg.agents[name]) cfg.agents[name].enabled = false; } }
  finally { const finished = Date.now(); state.runs = [{ runId, startedAt: new Date(started).toISOString(), finishedAt: new Date(finished).toISOString(), status: state.lastStatus, reason, durationMs: finished - started, summary: state.lastSummary, notificationSent: state.lastStatus === 'notified', error: state.lastError }, ...(state.runs || [])].slice(0, cfg.history); const failed = state.lastStatus === 'failed' || state.lastStatus === 'delivery_failed'; const delay = failed ? cfg.retry * Math.pow(2, Math.max(0, state.consecutiveFailures - 1)) : (cfg.agents[name]?.intervalMinutes || cfg.interval); state.nextDueAt = new Date(Date.now() + delay * 60000).toISOString(); await saveState(name); running.delete(name); if (release) await release().catch(() => {}); if (cfg.agents[name]?.enabled) schedule(name, new Date(state.nextDueAt).getTime() - Date.now()); }
  return { runId, status: state.lastStatus };
}
async function reloadConfig() { for (const t of timers.values()) clearTimeout(t); timers.clear(); readPluginConfig(); for (const name of Object.keys(cfg.agents)) { await loadState(name); const s = stateFor(name); const due = s.nextDueAt ? new Date(s.nextDueAt).getTime() : 0; schedule(name, due ? Math.max(0, due - Date.now()) : cfg.agents[name].intervalMinutes * 60000); } return getStatus(); }
function getStatus() { return { enabled: cfg.enabled, agents: Object.keys(cfg.agents).map(name => ({ name, config: cfg.agents[name], ...stateFor(name), running: running.has(name) })) }; }
async function initialize(config = {}, dependencies = {}) { deps = dependencies; injectedConfig = config; await reloadConfig(); }
async function shutdown() { stopping = true; for (const t of timers.values()) clearTimeout(t); timers.clear(); while (running.size) await new Promise(r => setTimeout(r, 50)); for (const n of states.keys()) await saveState(n); }
async function processToolCall(args = {}) { const command = String(args.command || args.action || 'status').toLowerCase(); const name = args.agentName || args.agent_name; if (command === 'status') return getStatus(); if (command === 'reload') return reloadConfig(); if (!name || !cfg.agents[name]) throw new Error('Unknown agent'); if (command === 'trigger') return run(name, args.reason || 'manual', true); if (command === 'enable' || command === 'disable') { const config = getConfig(); config.agents[name].enabled = command === 'enable'; await atomicWrite(path.join(ROOT, 'config.json'), config); await reloadConfig(); if (command === 'enable') { stateFor(name).consecutiveFailures = 0; scheduleNext(name, cfg.agents[name].intervalMinutes); } return getStatus().agents.find(a => a.name === name); } throw new Error(`Unknown command: ${command}`); }
function triggerAsync(name, reason = 'manual', force = true) { if (running.has(name) || queued.has(name)) return null; const runId = `hb-${Date.now()}-${hash(name).slice(0, 6)}`; queued.add(name); setImmediate(() => run(name, reason, force, runId).catch(() => { queued.delete(name); })); return runId; }
function getConfig() { return { version: 1, agents: JSON.parse(JSON.stringify(cfg.agents)) }; }
async function writeConfig(value) { const agents = {}; const assistant = deps.pluginManager?.getServiceModule('AgentAssistant'); const known = new Set(assistant?.listAgents?.().map(a => a.name) || []); for (const [name, raw] of Object.entries(value?.agents || {})) { if (!known.has(name)) throw new Error(`Unknown AgentAssistant agent: ${name}`); if (!Number.isFinite(Number(raw.intervalMinutes)) || Number(raw.intervalMinutes) < 5 || Number(raw.intervalMinutes) > 1440) throw new Error(`Invalid intervalMinutes for ${name}`); if (!validTime(raw.activeHours?.start) || !validTime(raw.activeHours?.end)) throw new Error(`Invalid active hours for ${name}`); try { new Intl.DateTimeFormat('en', { timeZone: raw.activeHours.timezone }).format(); } catch (_) { throw new Error(`Invalid timezone for ${name}`); } const item = normalizeAgent(raw); for (const tool of item.allowedTools) if (!deps.pluginManager?.getPlugin(tool)) throw new Error(`Unknown tool: ${tool}`); agents[name] = item; } await atomicWrite(path.join(ROOT, 'config.json'), { version: 1, agents }); return reloadConfig(); }
module.exports = { initialize, shutdown, processToolCall, triggerNow: (n, r) => run(n, r || 'manual', true), triggerAsync, isRunning: n => running.has(n) || queued.has(n), getStatus, getAgentStatus: n => getStatus().agents.find(a => a.name === n) || null, listRuns: (n, limit = 100) => (stateFor(n).runs || []).slice(0, limit), reloadConfig, getConfig, writeConfig, _test: { normalizeAgent, isChecklistEmpty, inActive, nextActive } };
