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

当待处理审批返回 `allow_for_run: 1` 时，可提交 `decision: "approve_run"`。它批准当前请求，并允许同一轮 Codex 执行中符合条件的待批命令和文件修改。每次答复都会重新检查项目授权。额外权限和补充信息继续单独询问。自动批准的决策记录用 `actor: "run_grant"` 标记，记录详情中的 `grant` 指向用户最初批准的请求。运行结束、断线或工作台重启后授权失效。

同一类待处理审批也接受 `decision: "approve_goal"`。这会把授权保存在本机，只用于这项委托在当前项目中的常规操作，后续手动或定时运行均可沿用。暂停期间不自动批准。结束委托、更换项目或停用项目会取消委托授权。自动批准记为 `actor: "goal_grant"`，详情中的 `grant` 指向原始审批。委托详情 `GET /goals/:id` 返回 `approvalGrant`（原审批 ID 或 null）。向 `POST /goals/:id/revoke-approval` 提交 `{"grant":"原审批 ID"}` 可撤销它。

对于 `masked_command: 1` 的待处理命令，本机会话可向 `POST /inbox/:id/review` 提交当前 `version`，临时查看原始命令和执行目录。选择 `approve` 或 `approve_goal` 时带上响应的 `reviewKey`。选择委托授权后，同一委托后续符合条件的脱敏命令可自动通过。普通委托授权和本轮授权不会自动扩大。委托详情的 `maskedCommandGrant` 指向这次扩展授权的审批；撤销委托授权时一并撤销。历史记录仅包含脱敏预览。

列表通常接受 limit 和 offset。活动列表可按 goalId、runId、provider、severity、type、search 过滤。活动不带 cursor 时逆序，带 cursor 时返回该序号以后的事件并升序排列。故事证据支持 until，以便重现历史快照。

实时流的 change 消息使用 SQLite 序号作为 SSE id，data 含事件和目标标识。首次连接可传 cursor，自动重连优先读取 Last-Event-ID。需要完整数据时通过活动和证据接口查询。心跳为 SSE 注释。
