# AgentHeartbeat

周期性唤醒已配置的 Agent 执行 Markdown 巡检清单。插件默认关闭，不会自动消耗模型额度。

1. 将 `config.env.example` 复制为 `config.env` 并设置 `HEARTBEAT_ENABLED=true`。
2. 将 `config.json.example` 复制为 `config.json`，Agent 名称须与 AgentAssistant 配置一致。
3. 在 `heartbeats/` 中创建对应 Markdown 清单。
4. 在管理面板的“Agent 心跳”页面启用、编辑或手动触发。

每轮使用临时 AgentAssistant 会话，仅注入显式白名单工具。`AgentAssistant`、`AgentHeartbeat` 和 `AgentMessage` 永远不会注入模型；通知由运行器直接投递，仍经过 VCP 原有工具执行链路。
