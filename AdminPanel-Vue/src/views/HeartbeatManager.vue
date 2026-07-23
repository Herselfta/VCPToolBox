<template>
  <section class="heartbeat-page">
    <Teleport to="#page-header-actions"><UiPageActions><UiButton variant="outline" @click="reload"><span class="material-symbols-outlined">refresh</span>重载配置</UiButton></UiPageActions></Teleport>
    <section class="status-band"><div><h2>主动巡检</h2><p>周期唤醒、无事静默、有事推送</p></div><UiBadge :variant="status?.enabled ? 'success' : 'default'">{{ status?.enabled ? '全局已启用' : '全局已关闭' }}</UiBadge></section>
    <div class="layout">
      <aside class="agents"><button v-for="agent in status?.agents || []" :key="agent.name" :class="{active: selected?.name === agent.name}" @click="select(agent)"><span><strong>{{ agent.name }}</strong><small>{{ agent.lastStatus || 'never' }}</small></span><UiBadge :variant="agent.config.enabled ? 'success' : 'default'">{{ agent.config.enabled ? '运行' : '暂停' }}</UiBadge></button><UiEmptyState v-if="!status?.agents.length" title="尚未配置 Agent" /></aside>
      <main v-if="selected" class="workspace">
        <div class="toolbar"><div><h3>{{ selected.name }}</h3><p>下次：{{ formatTime(selected.nextDueAt) }}</p></div><div><UiButton variant="outline" :disabled="selected.running" @click="trigger"><span class="material-symbols-outlined">play_arrow</span>立即巡检</UiButton><UiButton :variant="selected.config.enabled ? 'danger' : 'primary'" @click="toggle">{{ selected.config.enabled ? '暂停' : '启用' }}</UiButton></div></div>
        <section class="settings"><label>间隔（分钟）<UiInput v-model.number="form.intervalMinutes" type="number" min="5" max="1440" /></label><label>开始<UiInput v-model="form.start" type="time" /></label><label>结束<UiInput v-model="form.end" type="time" /></label><label class="tools">工具白名单（逗号分隔）<UiInput v-model="form.tools" placeholder="DailyNoteQuery, VCPChrome" /></label><UiButton @click="saveConfig"><span class="material-symbols-outlined">save</span>保存调度</UiButton></section>
        <section class="editor"><div><h3>HEARTBEAT.md</h3><UiButton variant="outline" @click="saveFile"><span class="material-symbols-outlined">save</span>保存清单</UiButton></div><UiTextarea v-model="markdown" :rows="12" placeholder="- 检查需要关注的事项" /></section>
        <UiAlert v-if="selected.lastError" variant="danger">{{ selected.lastError }}</UiAlert>
        <section class="runs"><h3>最近运行</h3><div v-for="run in selected.runs || []" :key="run.runId" class="run"><span><strong>{{ run.status }}</strong><small>{{ formatTime(run.startedAt) }} · {{ run.durationMs }} ms · {{ run.reason }}</small></span><p>{{ run.summary || run.error || '无摘要' }}</p></div><UiEmptyState v-if="!selected.runs?.length" title="暂无运行记录" /></section>
      </main>
    </div>
  </section>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { heartbeatApi, type HeartbeatAgent, type HeartbeatStatus } from '@/api'
import UiAlert from '@/components/ui/UiAlert.vue'; import UiBadge from '@/components/ui/UiBadge.vue'; import UiButton from '@/components/ui/UiButton.vue'; import UiEmptyState from '@/components/ui/UiEmptyState.vue'; import UiInput from '@/components/ui/UiInput.vue'; import UiPageActions from '@/components/ui/UiPageActions.vue'; import UiTextarea from '@/components/ui/UiTextarea.vue'; import { showMessage } from '@/utils'
const status = ref<HeartbeatStatus|null>(null), selectedName = ref(''), markdown = ref(''); const form = reactive({ intervalMinutes: 30, start: '08:00', end: '23:00', tools: '' }); let timer: number|undefined
const selected = computed(() => status.value?.agents.find(a => a.name === selectedName.value) || null)
function sync(a: HeartbeatAgent) { form.intervalMinutes=a.config.intervalMinutes; form.start=a.config.activeHours.start; form.end=a.config.activeHours.end; form.tools=a.config.allowedTools.join(', ') }
async function load() { status.value=await heartbeatApi.status(); if (!selectedName.value && status.value.agents[0]) await select(status.value.agents[0]); else if (selected.value) sync(selected.value) }
async function select(a: HeartbeatAgent) { selectedName.value=a.name; sync(a); markdown.value=(await heartbeatApi.getFile(a.name)).content }
async function reload() { status.value=await heartbeatApi.reload(); showMessage('心跳配置已重载', 'success') }
async function trigger() { if (!selected.value) return; const x=await heartbeatApi.trigger(selected.value.name); showMessage(`已提交运行 ${x.runId}`, 'success'); setTimeout(load, 1000) }
async function toggle() { if (!selected.value) return; await heartbeatApi.toggle(selected.value.name, !selected.value.config.enabled); await load() }
async function saveConfig() { if (!selected.value) return; await heartbeatApi.saveConfig(selected.value.name, { intervalMinutes: form.intervalMinutes, activeHours:{start:form.start,end:form.end,timezone:selected.value.config.activeHours.timezone}, allowedTools:form.tools.split(',').map(x=>x.trim()).filter(Boolean) }); await load(); showMessage('调度配置已保存','success') }
async function saveFile() { if (!selected.value) return; await heartbeatApi.saveFile(selected.value.name, markdown.value); showMessage('心跳清单已保存','success') }
function formatTime(v?:string|null) { return v ? new Date(v).toLocaleString() : '未安排' }
onMounted(async()=>{ await load(); timer=window.setInterval(load,5000) }); onBeforeUnmount(()=>timer&&clearInterval(timer))
</script>
<style scoped>
.heartbeat-page{display:grid;gap:16px}.status-band{display:flex;align-items:center;justify-content:space-between;padding:18px 0;border-bottom:1px solid var(--border-color)}h2,h3,p{margin:0}.status-band p,.toolbar p,small{color:var(--text-secondary)}.layout{display:grid;grid-template-columns:minmax(210px,260px) 1fr;gap:16px}.agents{border-right:1px solid var(--border-color);padding-right:12px}.agents button{width:100%;display:flex;justify-content:space-between;align-items:center;padding:12px;border:0;border-bottom:1px solid var(--border-color);background:transparent;text-align:left}.agents button.active{background:var(--surface-hover)}.agents span,.run span{display:grid;gap:4px}.workspace{min-width:0;display:grid;gap:18px}.toolbar,.toolbar>div,.editor>div{display:flex;align-items:center;justify-content:space-between;gap:8px}.settings{display:grid;grid-template-columns:repeat(3,minmax(120px,1fr));gap:12px;align-items:end}.settings label{display:grid;gap:6px}.settings .tools{grid-column:1/-1}.editor{display:grid;gap:8px}.runs{display:grid;gap:8px}.run{display:grid;grid-template-columns:minmax(170px,240px) 1fr;gap:12px;padding:10px 0;border-bottom:1px solid var(--border-color)}.run p{white-space:pre-wrap;overflow-wrap:anywhere}@media(max-width:800px){.layout{grid-template-columns:1fr}.agents{border-right:0;padding:0}.settings{grid-template-columns:1fr}.run{grid-template-columns:1fr}}
</style>
