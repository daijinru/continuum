# Continuum V1.0 规格验收评估

依据：`continuum-implementation-spec.md`（2026-11-20），重点为 §1.3 的使用流程和 §13 的完成标准。评估日期：2026-11-23。**结论：全新数据目录可以跑通 Demo，但当前默认数据目录启动失败，且浏览器验收存在间歇性失败，未通过整体验收。**

## 验收结果

| 规格范围 | 当前证据与结果 |
| --- | --- |
| §3–4 工程与存储 | Web、API、同进程 worker、共享契约、两个适配器均有实现；5 个 SQLite 迁移可在空库运行。使用原生 SQLite、Node 测试运行器等替代建议栈，不以框架差异判失败。 |
| §5–6 执行与事件 | Demo 完整链路通过；真实适配器包含生成类型、stdio 握手、线程续接、审批及读取线程核对逻辑。本次环境未找到 CLI，真实事件、文件及续线程未复验。 |
| §7–8 故事与简报 | 测试覆盖证据升降级、重复和乱序事件、快照、已读游标和安静态；但从断连核对为失败时，风险会从当前故事中消失；重要度中的新颖度固定为 1。 |
| §9 Inbox | 测试覆盖版本冲突、重复决定、延后、拒绝、过期、失联和人工核对。Demo 审批端到端通过；真实请求应与 CLI 在目标环境联合验收。 |
| §10 调度与恢复 | 已测试租约、日额度、退避、暂停和重启幂等。路径不变时可恢复 Demo 待审批任务；当前数据库随项目迁移后无法完成启动恢复。 |
| §11–12 API 与界面 | Playwright 通过主界面流程、移动宽度、主题、控制台错误检查及 SSE 游标重放。目标详情有验收项、故事、产物和计划，但故事仍是平铺列表，未按里程碑分组（`apps/web/src/Goals.tsx:309–317`）。 |
| §13 交付资料 | README、架构、API、协议、决策、实施记录、历史测试报告和七张截图齐备。可选模型润色尚未接入，不作为阻塞项。 |

## 按优先级处理

1. **阻塞：旧工作区路径导致整个 API 不能启动（§1.3 C、§10、§13.5）。** 当前 `.local/continuum.sqlite` 含一条 `waiting_approval` 运行和一条待处理审批。工作区指向移动前的 `…/kl-fa/outputs/continuum/.local/demo-project`，该路径已不存在。在数据库一致性备份上启动，进程在监听前以状态 1 退出，错误为「目录不存在或无法访问」。调用链是 `server.ts:38 → service.ts:490 → service.ts:78 → db.ts:130`（均在 `apps/api/src/`）。建议逐运行隔离恢复失败，让用户仍能打开设置，重新授权目录；旧审批不能因为路径重新绑定而自动生效。补测：移动含待审批运行的数据库后能查看历史、处理失效请求，并在明确授权后开启新运行。
2. **高：核对出的失败不会形成风险故事（§7、§10）。** 在临时数据库注入 `run.started → system.disconnected → system.reconciled(status=failed)`，最终运行正确为 `failed`，但该目标唯一故事是 `change / reported`。`packages/briefing/src/index.ts:36–41,54–89` 使用同一连接故事键，失败判断未检查核对事件的终态。建议按核对结果分类，并测试到简报及 Goal 健康状态；不能仅断言运行表正确。
3. **验收待补：目标环境真实 Codex（§5、§13.2）。** `pnpm test:codex` 显示 `installed:false, ready:false`，未执行模型任务。`docs/test-report.md` 记录 11 月 20 日在 CLI 0.169.1 上通过临时仓库写文件和同线程续跑。这是历史证据，不是本次通过。目标环境 CLI 和登录就绪后，再按已安装版本核对生成协议并运行该验收。
4. **较低：重要度与展示（§7、§12）。** `packages/briefing/src/index.ts:91–97` 虽采用规格权重，但传入的新颖度恒定；游标能筛掉已读事件，却不能区分新故事和已知故事的新进展。补上跨游标排序用例，再补目标详情的里程碑分组。

## 本次执行证据

macOS，Node v24.21.0，pnpm 10.4.1。工程检查在含现有依赖的隔离副本执行；默认数据库故障另以 SQLite `.backup` 生成的一致性副本验证。

| 命令 / 检查 | 实际结果 |
| --- | --- |
| `pnpm install --frozen-lockfile --offline` | 成功；复用已有依赖，不代表从空缓存联网安装。 |
| `pnpm db:migrate` | 空库迁移 1–5 成功。 |
| `pnpm typecheck`、`pnpm lint`、`pnpm build` | 均通过。 |
| `pnpm test` | 13/13 通过。 |
| `pnpm test:e2e` | 2/2 通过；隔离副本生成七张截图。仓库已有截图见 [screenshots/](screenshots/)。 |
| `PORT=4396 pnpm dev`，全新数据 | 首页 HTTP 200，`/api/v1/health` 返回 `ready:true`；验证后停止服务。 |
| `CONTINUUM_DATA=<现库备份目录> node apps/api/src/main.ts` | 启动失败，退出码 1，原因见阻塞项。 |
| `codex --version`、`codex login status`、`pnpm test:codex` | 当前 PATH 无 `codex`；真实验收脚本退出码 1。 |

临时体验独立 Demo 可用 `CONTINUUM_DATA="$(mktemp -d)" pnpm dev`，打开 `http://127.0.0.1:4317/`。这不会恢复原库中的待审批任务。

## 同日复核：当前代码与默认数据

- 在独立项目副本上执行 `pnpm install --offline --frozen-lockfile`、`pnpm db:migrate`、`pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build`：均通过，空库迁移 1–5，单元及集成测试 13/13。
- **浏览器测试不能认定为稳定通过。** `pnpm test:e2e` 首次 1/2，通过的是 SSE 重放；未改代码重跑后 2/2。首次失败在 `tests/browser/ui.spec.ts:54–56`：测试按索引选择工作区，失败快照显示实际选中「添加本地目录…」，必填的绝对路径为空，表单未提交。`apps/web/src/Goals.tsx:30,81–89` 异步载入允许目录，导致同一索引的含义会改变。建议等目标选项出现后按名称或值选择，并为表单显示目录加载状态。
- 从当前默认库只读生成 SQLite 一致性备份，在备份目录执行 `PORT=0 CONTINUUM_DATA=<备份目录> node apps/api/src/main.ts`，退出码 1，重现 `Service.recover` 在监听前抛出「目录不存在或无法访问」。
- 在独立 Demo 数据库依次写入失联、核对为 `failed` 两个事件并生成简报，确认运行已失败，而对应故事显示 `change / reported / 已核对提供方状态`，未提示失败。
- `pnpm test:codex` 返回 `installed:false, ready:false` 并以 1 退出。本次未验证真实审批、文件产物或线程续跑。
