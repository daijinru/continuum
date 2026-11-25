# Continuum · 本地委托工作台

在一个主对话里交代事情、询问进度、接收结果。每项委托有自己的排期和偏好；你不用打开多个聊天室，也不用盯着执行日志。

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="design-demos/macos/workbench-dark.png">
  <img src="design-demos/macos/workbench-desktop.png" alt="Continuum 石墨灰主对话：窄侧栏、结果与来源、固定输入区">
</picture>

*正式界面，截图使用示例数据。* [浅色大图](design-demos/macos/workbench-desktop.png) · [深色大图](design-demos/macos/workbench-dark.png)

<details>
<summary>查看窄屏布局</summary>

<img src="design-demos/macos/workbench-mobile.png" width="320" alt="375 像素窄屏：可折叠的导航和底部输入区">

</details>

## 在本机启动

已验证 macOS、Node.js 24.x（至少 24.10）、pnpm 10.4.1。

```sh
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm dev
```

打开 **<http://127.0.0.1:4317/>**。首次启动默认带有无需账号的 DEMO 记录；想从空工作台开始，在首次启动前把 `.env.example` 复制为 `.env`，加入 `CONTINUUM_SEED=0`。这不会清空已有数据。已有前端构建时可直接 `pnpm start`。

自然语言研判与真实执行需要本机 Codex CLI 和有效登录，已验证的协议基线是 `0.169.1`。在「设置 → 检查连接」核对；DEMO 不代表模型已连接。

**查看 token 用量**：主对话输入框下方显示理解消息的用量；「我的委托 → 委托详情」显示该项执行与筛选用量；「设置」显示工作台累计输入、输出和总量。只统计 Codex 已报告的计数，不是账单。未上报的旧任务、DEMO 不补算，已计入输入的缓存和已计入输出的推理不重复相加。

开源的 [ccusage](https://ccusage.com/guide/codex/) 适合从 Codex 本机会话日志生成日/月或会话报告。工作台没有扫描 `~/.codex`：临时研判直接读取 `codex exec --json` 的 `turn.completed.usage`，执行按本工作台所属线程保存 `thread/tokenUsage/updated` 的累计快照。同一线程继续运行只更新快照。

## 试着交代两件事

> 帮我留意 GitHub 热榜上适合普通人用的新工具，有值得看的再说。另外，周五上午提醒我准备周会。

- 工作台在主对话里确认两项安排。「有变化再报」和「每天给我一份」是不同的承诺；读取失败不会被当成没有变化。
- 点 **问进度** 只查询记录，不重跑委托，也不会覆盖输入框里的草稿。点某条结果下的 **回复这条**，可以单独调整那项委托。
- **我的委托** 查看排期与历史，**今日简报** 阅读交付、查看待决定的事。需要追溯时再展开「关联记录」。
- 点击侧栏底部的 **运行监测** 查看正在工作、等待决定、等待排期和暂停的委托，以及工作台和子进程的 CPU、常驻内存。可从进程明细打开关联运行；仅在监测页可见时自动采样。
- `⌘K` 聚焦输入，`⌘↵` 发送。未手动指定时跟随系统明暗外观。

当前原生关注来源是 GitHub Trending 日榜；支持单次、每天、工作日的本地排期。提醒发到主对话，不是 macOS 系统通知。机器睡眠或服务关闭时不能准点执行，恢复后的补发提醒会标明原定时间。

## 数据与执行边界

SQLite 默认在 `.local/continuum.sqlite`，配置项见 [.env.example](.env.example)。API 监听回环地址；API 和调度器共用写连接。默认新工作在专属目录的写入沙箱内运行，不自动提升权限；选择已有项目时沿用该项目的授权策略。运行失联先核对状态，不盲目重做外部操作。

## 开发与验证

```sh
pnpm harness status
pnpm lint
```

日常 PR 以 GitHub Actions 的 `lint` 为必需检查；按改动补跑 `pnpm typecheck`、`pnpm test`、`pnpm build` 或构建后的 `pnpm test:e2e`。浏览器测试使用临时数据库和 4389 端口，可设置 `CHROME_PATH`。`pnpm test:codex` 是独立的真实模型验收，需要有效登录并消耗模型配额。

工作分支推送后，用 `pnpm harness pr submit --issue N` 申请自动合并并跟到合入 **`main`**。若检查失败，在原分支修复、验证并推送，用 `pnpm harness pr watch <PR编号>` 接续。GitHub 在合并后自动删除远端源分支。本机自动清理设置和保留条件见 [分支清理](docs/harness.md#分支清理)。

[仓库 harness](docs/harness.md) · [架构与恢复](docs/architecture.md) · [API](docs/api.md) · [Codex 协议](docs/protocol.md) · [设计与截图](design-demos/macos/direction-approved.md)
