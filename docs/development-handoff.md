# Continuum 应用开发交接

第一次接手 Continuum 时，可以沿着下面的例子了解产品，再按手头的问题查实现和测试。开始维护前先运行 `pnpm harness status` 核对当前分支、暂存区和工作区。提交与 PR 的交付流程见[仓库协作约定](../AGENTS.md)。

## 用户为什么需要 Continuum

Continuum 是一个面向单用户、优先支持 macOS 的本地委托工作台。用户把事情交代一次，之后只需要在有结果、需要决定，或工作遇到阻碍时回来。这个设计参考了 [Super-agent 的注意力原则](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/000-philosophy.md)。

- 用户在同一个主对话里用自然语言交代多件事、询问进度、纠正偏好，需要时才选择项目。委托详情用来核对单项工作的记录。
- 交付要让用户知道发生了什么，以及接下来需要做什么。先给用户能读的报告或能打开的软件，需要追溯时再展开运行依据。
- 石墨灰工作台采用窄侧栏、固定输入区和紧凑的消息流，靠文字、间距与分隔线区分层次。[界面设计与截图](../design-demos/macos/direction-approved.md)
- 「计划室」是用 Continuum 开发的独立应用。其代码和早期原型分别在 [products/planroom](../products/planroom/README.md) 和 [examples/planner](../examples/planner/README.md)。

## 一条消息如何变成两项委托

> “留意 GitHub 热榜上适合普通人用的新工具，有值得看的再说。另外，周五上午提醒我准备周会。”

这句话产生两项承诺。热榜委托在有值得推荐的工具时才发消息。如果用户说的是“每天给我一份”，即使当天没有新发现也要按约定交付。周五的提醒则到点直接写入主对话，无需启动 Codex。

随后问“现在都怎么样了？”，工作台直接汇总已有记录。在推荐下点「回复这条」说“以后少报插件”，只修改热榜委托。两项都活跃、又无法确定“先停一下”指哪项时，先询问用户。读取榜单失败要记为失败，暂停或修改过的委托也要在投递前重新核对。

## 从行为找到实现

主对话里可以有多项长期委托，每项用一个 `Goal` 保存。一次 `AgentRun` 代表一次执行尝试，Codex 的 thread 和 turn 记录执行器上下文。是否把结果交付到主对话，取决于这项委托约定的通知方式。

| 要改的行为 | 先读哪里 |
|---|---|
| 输入一句话、回复归属、查进度、修改/暂停/恢复 | [`apps/api/src/main-conversation.ts`](../apps/api/src/main-conversation.ts)：`MainConversation.handle`、`progress`、`post`。明确归属和常见只读查询先用程序判断；其余由模型提议动作，再由服务校验和写入。 |
| 自然语言路由、热榜候选筛选 | [`apps/api/src/main-model.ts`](../apps/api/src/main-model.ts)：`interpret` 与 `chooseRepos`。只读研判与执行工作是不同职责，模型不能直接写库或自行扩大权限。 |
| 提醒、长期关注、重试和静默 | [`apps/api/src/main-agenda.ts`](../apps/api/src/main-agenda.ts)：`MainAgenda`。保存来源快照；先区分已观察与已通知，再决定是否发回主对话。连续三次失败提示一次；投递前检查委托是否仍有效。 |
| 普通任务、已有项目和恢复 | [`apps/api/src/service.ts`](../apps/api/src/service.ts) 管理运行和事务；[`apps/worker/src/index.ts`](../apps/worker/src/index.ts) 派发普通工作队列、处理旧排期和失联核对；[`packages/codex-adapter/src/`](../packages/codex-adapter/src/) 对接 Codex App Server。不要给同一委托接两套排期。 |
| 项目目录丢失、审批和撤销 | [目录恢复](../apps/api/src/directory-recovery.ts)保留待派发工作。项目决定工作在哪个目录执行，操作审批决定哪些动作可以执行。委托授权绑定当前委托和项目，可跨轮次。具体批准条件见[本机 API](api.md)。 |
| 消息、记忆与持久化 | [`migrations/007_main_conversation.sql`](../migrations/007_main_conversation.sql)：`main_messages` / `main_refs` 是单一消息流及委托关联；`main_tasks` 保存排期、最近尝试与最近成功；`main_observations` 是观察快照；`main_notified` 是已推荐记录。**已观察、已通知、用户已读是三件不同的事。** |
| 消息发送、同步和翻历史 | [发送队列](../apps/web/src/conversation-outbox.ts)保留发送键和回复对象。[主对话](../apps/web/src/Conversation.tsx)合并分页和增量数据，[历史列表](../apps/web/src/ChatHistory.tsx)维护阅读位置。[同步接口](api.md#主对话同步)说明旧审批的状态变化如何回到已打开的页面。 |
| 委托详情、简报与历史依据 | [委托详情](../apps/web/src/Goals.tsx)展示授权和交付记录。[今日简报](../apps/web/src/Feed.tsx)和[简报生成](../packages/briefing/src/index.ts)负责简报与历史快照。 |

SQLite 由本机 API 单实例持有写连接。改执行链路时，核对同一条指令重试、并发到达、暂停或重启后的结果。各进程的职责和恢复时序见[架构与数据流](architecture.md)。

## 在隔离数据上验证

新检出按 [README](../README.md#在本机启动) 安装依赖并启动。若要确认默认端口上的工作台是否就绪，运行 `curl -fsS http://127.0.0.1:4317/api/v1/health` 并查看 `data.ready`。在 macOS 上独立试验时，可在安装依赖后运行 `CONTINUUM_DATA="$(mktemp -d)" CONTINUUM_SEED=0 PORT=4396 pnpm dev`，用临时空库和另一个端口验证。

| 要验证的行为 | 用哪组测试 |
| --- | --- |
| 一句话交代多件事、问进度、回复和断线后补读 | [主对话测试](../tests/main-conversation.test.ts)，运行 `node --test tests/main-conversation.test.ts`。调整下一次交付要求另见[委托测试](../tests/commission.test.ts)。 |
| 同一委托跨轮授权，同项目下其他委托仍单独审批 | [委托授权测试](../tests/goal-approvals.test.ts)，运行 `node --test tests/goal-approvals.test.ts`。 |
| 输入后立即显示、发送失败、审批折叠 | [主对话交互测试](../tests/browser/graphite.spec.ts)。 |
| 长会话空闲、收到新消息、翻页时的阅读位置 | [同步测试](../tests/browser/conversation-sync.spec.ts)检查空闲时的请求数，[历史列表测试](../tests/browser/conversation-history.spec.ts)用 1,600 条示例消息检查渲染行数和阅读位置，也覆盖窄屏表单。 |

运行上表的界面测试时，先 `pnpm build`，再运行 `pnpm test:e2e graphite.spec.ts conversation-sync.spec.ts conversation-history.spec.ts`。测试会启动隔离服务。运行完整浏览器套件时可用 `SCREENSHOT_DIR="$(mktemp -d)" pnpm test:e2e` 把截图写到临时目录。

## 判断一项委托的交付质量

普通工作可以把执行器的末条回复作为交付。核对具体结果时，还要查看报告、产物或关联的运行依据。持续关注则要同时考虑是否按约定提醒，以及提醒是否值得用户打开。可以用同一项关注观察五个工作日，记录哪些消息值得收到、哪些重复、何时漏报，以及何时必须主动问进度。

向新会话交接时，写明本次要解决的用户问题，然后附上对应的实现和测试入口。支持的来源、排期和提醒渠道见 [README](../README.md#试着交代两件事)。
