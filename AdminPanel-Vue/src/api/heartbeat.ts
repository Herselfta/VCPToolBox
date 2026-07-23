import { requestWithUi, type RequestUiOptions } from './requestWithUi'
export interface HeartbeatAgent { name: string; enabled: boolean; running: boolean; lastStatus: string; lastError?: string | null; lastRunAt?: string | null; nextDueAt?: string | null; consecutiveFailures: number; config: { enabled: boolean; intervalMinutes: number; activeHours: { start: string; end: string; timezone: string }; allowedTools: string[] }; runs: HeartbeatRun[] }
export interface HeartbeatRun { runId: string; startedAt: string; status: string; reason: string; durationMs: number; summary: string; notificationSent: boolean; error?: string | null }
export interface HeartbeatStatus { enabled: boolean; agents: HeartbeatAgent[] }
const quiet: RequestUiOptions = { showLoader: false }
export const heartbeatApi = {
  status: (ui = quiet) => requestWithUi<HeartbeatStatus>({ url: '/admin_api/heartbeat/status' }, ui),
  trigger: (name: string) => requestWithUi<{runId:string}>({ url: `/admin_api/heartbeat/agents/${encodeURIComponent(name)}/trigger`, method: 'POST', body: { reason: 'manual', force: true } }),
  toggle: (name: string, enabled: boolean) => requestWithUi<HeartbeatAgent>({ url: `/admin_api/heartbeat/agents/${encodeURIComponent(name)}/${enabled ? 'enable' : 'disable'}`, method: 'POST' }),
  saveConfig: (name: string, config: unknown) => requestWithUi<HeartbeatStatus>({ url: `/admin_api/heartbeat/agents/${encodeURIComponent(name)}/config`, method: 'PUT', body: config }),
  getFile: (name: string) => requestWithUi<{content:string}>({ url: `/admin_api/heartbeat/agents/${encodeURIComponent(name)}/file` }, quiet),
  saveFile: (name: string, content: string) => requestWithUi<{success:boolean}>({ url: `/admin_api/heartbeat/agents/${encodeURIComponent(name)}/file`, method: 'PUT', body: { content } }),
  reload: () => requestWithUi<HeartbeatStatus>({ url: '/admin_api/heartbeat/reload', method: 'POST' })
}
