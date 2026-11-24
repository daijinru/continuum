# 验证报告

验证日期为 2026-11-20。环境为 macOS、Node.js 24.21.0、pnpm 10.4.1、Codex CLI 0.169.1。Playwright 使用本机 Chrome。

| 命令 | 实际结果 |
| --- | --- |
| pnpm install | 成功解析并安装工作区依赖，保留 pnpm-lock.yaml |
| pnpm db:migrate | 成功创建或升级数据库，迁移版本 1 至 5 |
| pnpm typecheck | TypeScript strict 检查通过 |
| pnpm lint | ESLint 通过 |
| pnpm build | TypeScript 和 Vite 生产构建通过 |
| pnpm test | 13 项全部通过 |
| pnpm test:e2e | 2 项全部通过，覆盖浏览器工作流与 SSE 断线补读 |
| pnpm test:codex | 真实任务成功，文件内容及事件证据通过核对，第二轮继承同一线程并成功结束 |
| pnpm dev | 成功在 127.0.0.1:4317 提供首页和 API 健康检查 |

## 已核对的行为

- 两个进程不能同时持有同一数据目录。SQLite 实测覆盖迁移、唯一约束、重复事件、乱序、证据升级及后来失败推翻旧结论。
- 同目标并发保护、不同目标隔离、跨目标指令拒绝、目录符号链接替换、路径越界、会话与来源检查均有自动化断言。
- 审批覆盖批准、拒绝、稍后处理、双击、过期、断连、版本冲突、幂等重试和审计。补充输入及人工核对通过隔离适配器夹具验证。
- 调度覆盖暂停、日额度、冷却、租约竞争、过期租约、重启后识别已有运行和重试上限。
- 简报覆盖读游标、重复生成、历史快照、安静状态与证据排序。浏览器实测新建目标、启动、指令历史、深色主题及 390 像素宽布局。主流程没有页面异常或控制台错误。
- 真实任务在独立临时 Git 仓库新增 README，审批只放行该文件的一次新增。验收读取文件内容为 `Continuum scratch check`，查询到 artifacts 记录和 verified 简报条目。后续轮次保持 thread id，产生新的 turn id 和 run id。
- 早期对照试验拒绝写入，提供方报告轮次结束，但磁盘文件校验失败。最终验收同时要求终态、磁盘内容、产物关联和简报证据。

## 页面截图

| 页面 | 截图 |
| --- | --- |
| 今日简报 | [有变化](screenshots/today.png) · [已读后无变化](screenshots/today-quiet.png) |
| 目标详情 | [目标与验收条件](screenshots/goal.png) |
| 收件箱 | [等待审批](screenshots/inbox-pending.png) · [完成审批](screenshots/inbox-completed.png) |
| 活动 | [展开原始事件](screenshots/activity.png) |
| 设置 | [Codex 不可用](screenshots/disconnected.png) |

断连截图使用测试服务的隔离 PATH，确保该服务找不到 Codex；正式连接测试使用正常的本机环境。安装依赖、真实模型访问、绑定本机测试端口和无头 Chrome 在受限沙箱外获准后执行。

