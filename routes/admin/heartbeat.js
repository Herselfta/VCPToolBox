const express = require('express');
const fs = require('fs').promises;
const path = require('path');

module.exports = function ({ pluginManager }) {
  const router = express.Router();
  const root = path.resolve(__dirname, '..', '..', 'Plugin', 'AgentHeartbeat', 'heartbeats');
  const service = () => pluginManager?.getServiceModule('AgentHeartbeat');
  const fail = (res, e) => res.status(e.status || 500).json({ error: e.message || String(e) });
  const named = (req, res) => { const name = req.params.agent; if (!/^[^\\/\0.]{1,100}$/.test(name)) { res.status(400).json({ error: 'Invalid agent name' }); return null; } const svc = service(); if (!svc) { res.status(503).json({ error: 'AgentHeartbeat unavailable' }); return null; } if (!svc.getAgentStatus(name)) { res.status(404).json({ error: 'Agent not configured' }); return null; } return { name, svc }; };
  const heartbeatPath = name => { const file = path.resolve(root, `${name}.md`); if (!file.startsWith(root + path.sep)) throw Object.assign(new Error('Invalid path'), { status: 400 }); return file; };

  router.get('/heartbeat/status', (req, res) => { const svc = service(); if (!svc) return res.status(503).json({ error: 'AgentHeartbeat unavailable' }); res.json(svc.getStatus()); });
  router.get('/heartbeat/agents', (req, res) => { const svc = service(); if (!svc) return res.status(503).json({ error: 'AgentHeartbeat unavailable' }); res.json({ agents: svc.getStatus().agents }); });
  router.get('/heartbeat/agents/:agent/runs', (req, res) => { const x = named(req, res); if (x) res.json({ runs: x.svc.listRuns(x.name, Math.min(500, Number(req.query.limit) || 100)) }); });
  router.post('/heartbeat/agents/:agent/trigger', (req, res) => { const x = named(req, res); if (!x) return; if (x.svc.isRunning(x.name)) return res.status(409).json({ error: 'busy' }); const runId = x.svc.triggerAsync(x.name, String(req.body?.reason || 'manual').slice(0, 100), req.body?.force !== false); res.status(202).json({ runId }); });
  for (const command of ['enable', 'disable']) router.post(`/heartbeat/agents/:agent/${command}`, async (req, res) => { const x = named(req, res); if (!x) return; try { res.json(await x.svc.processToolCall({ command, agentName: x.name })); } catch (e) { fail(res, e); } });
  router.put('/heartbeat/agents/:agent/config', async (req, res) => { const x = named(req, res); if (!x) return; try { const config = x.svc.getConfig(); config.agents[x.name] = { ...config.agents[x.name], ...(req.body || {}), heartbeatFile: `heartbeats/${x.name}.md` }; res.json(await x.svc.writeConfig(config)); } catch (e) { e.status = 400; fail(res, e); } });
  router.get('/heartbeat/agents/:agent/file', async (req, res) => { const x = named(req, res); if (!x) return; try { res.json({ content: await fs.readFile(heartbeatPath(x.name), 'utf8') }); } catch (e) { if (e.code === 'ENOENT') return res.json({ content: '' }); fail(res, e); } });
  router.put('/heartbeat/agents/:agent/file', async (req, res) => { const x = named(req, res); if (!x) return; try { const content = String(req.body?.content ?? ''); if (Buffer.byteLength(content) > 256 * 1024) return res.status(413).json({ error: 'File too large' }); await fs.mkdir(root, { recursive: true }); const file = heartbeatPath(x.name), tmp = `${file}.tmp-${process.pid}`; await fs.writeFile(tmp, content, 'utf8'); await fs.rename(tmp, file); res.json({ success: true }); } catch (e) { fail(res, e); } });
  router.post('/heartbeat/reload', async (req, res) => { const svc = service(); if (!svc) return res.status(503).json({ error: 'AgentHeartbeat unavailable' }); try { res.json(await svc.reloadConfig()); } catch (e) { fail(res, e); } });
  return router;
};
