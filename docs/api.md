# 本机 API

统一前缀为 `/api/v1`。成功响应使用 `{"data": ...}`，失败返回 `{"data":null,"error":"说明"}`。读取 `GET /session` 可以取得当前进程的令牌，修改操作通过 `X-Continuum-Token` 请求头携带令牌。浏览器请求须同源。本服务仅供本机用户使用。

| 资源 | 主要操作 |
| --- | --- |
| 系统 | GET /health、/system/status、/settings、/agent-connections；POST /agent-connections/check |
| 运行监测 | GET /system/monitor：`sampledAt`、`processes`（采样失败为 null）、`tasks`；仅在读取时采样，3 秒内复用进程快照。 |
| 服务重启 | `GET /settings` 的 `service` 提供 `instance` 和 `canRestart`。同源 `POST /system/restart` 需会话令牌和 `{ "instance": "当前实例 UUID" }`。收到 `accepted` 仅表示已受理；以 `GET /health` 返回不同的 `instance` 且 `ready: true` 为准。 |
| 设置 | PATCH /settings；POST /workspaces；PATCH /workspaces/:id |
| 目标 | GET、POST /goals；GET、PATCH /goals/:id；POST /goals/:id/check |
| 控制 | POST /goals/:id/start、/pause、/resume、/interrupt；POST /runs/:id/reconcile |
| 运行 | GET /goals/:id/runs、/runs/:id、/runs/:id/events、/runs/:id/artifacts |
| 进展和证据 | GET /stories、/stories/:id、/stories/:id/events、/events/:id |
| 简报 | GET /briefings、/briefings/:id；POST /briefings/generate、/briefings/:id/acknowledge |
| 收件箱 | GET /inbox、/inbox/:id；POST /inbox/:id/decision |
| 跟进 | POST /chat/messages；目标详情返回指令历史 |
| 主对话中的目录提醒 | `GET /conversation` 返回提醒及原路径。向 `POST /conversation/directories/:id` 传 `{}` 可立即检查原目录，传 `{"path":"/new/project"}` 可为这项委托确认新位置。`:id` 为提醒消息的 ID。同一提醒重试会返回已有处理结果。 |
| 计划 | POST /goals/:id/schedules、/schedules/:id/stop；PATCH /goals/:id/limits |
| 活动 | GET /activity、/stream |

新建目标提供 `title, description, criteria[], workspaceId, provider`。启动请求提供 UUID 格式的 `key`；携带 `continue:true` 可继续上次已有线程。审批答复提供 `decision, version, key`。审批使用 approve、deny、defer。输入类请求用 answer 和 answers。失联核对使用 record、observed 和 note。过期或并发竞争返回 409。输入错误及策略拒绝返回 422。

列表通常接受 limit 和 offset。活动列表可按 goalId、runId、provider、severity、type、search 过滤。活动不带 cursor 时逆序，带 cursor 时返回该序号以后的事件并升序排列。故事证据支持 until，以便重现历史快照。

实时流的 change 消息使用 SQLite 序号作为 SSE id，data 含事件和目标标识。首次连接可传 cursor，自动重连优先读取 Last-Event-ID。需要完整数据时通过活动和证据接口查询。心跳为 SSE 注释。
