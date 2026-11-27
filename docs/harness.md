# 仓库开发 harness · v1

面向维护 `daijinru/continuum` 的人和 coding agent。`AGENTS.md` 定义协作约定；`scripts/harness.ts` 提供可验证的操作。它使用 Git 的真实暂存区、提交 SHA 和 GitHub Issue 编号，没有另一套工单数据库。仓库中可运行 `pnpm harness --help`；程序消费 JSON 时使用 `node scripts/harness.ts …`（避免 pnpm 命令横幅）。

## 如何拆分一次请求

开工前为每个预期结果写一句验收条件。判断时问：“其他改动推迟，这一项合入后还能独立验证并使用吗？”可以就单独交付。仅有一项时，直接走下面的建单和提交流程。

| 请求 | 交付边界 |
| --- | --- |
| 折叠主会话里的重复审批，发送消息后立刻上屏 | 两个 PR。前者用连续审批验收，后者用慢响应验收，可分别上线。 |
| 发送消息后立刻上屏，收到服务端确认后只保留一条 | 一个 PR。即时显示、服务端确认和防重测试共同保证同一次发送的体验。 |
| 一次优化主会话关联记录、委托详情操作、交付列表边框 | 三个 PR。分别检查长标题展开、管理操作的入口和列表边框。共用样式随第一个实际使用它的改动交付。 |

每个结果各自查找或创建 Issue。若已有一个覆盖多项结果的 Issue，用它列出各项 Issue 链接并跟踪整体进度。每个 PR 用 `Closes #N` 关闭自己的任务，需要说明依赖时使用普通 Issue 链接。等各项完成并核对总目标后，再关闭总 Issue。

在当前检出逐项交付。有依赖时先合入前置任务，再从更新后的 `origin/main` 开下一分支。实现途中发现另一项属于本次请求的独立结果，就加入交付清单并单独处理。提交前再看一次完整 diff，确保能说明每处改动如何支持当前 Issue 的验收。

## 从问题到交付

以下 `42`、分支、路径和正文都是示例，不会自动执行。

```sh
pnpm harness status
pnpm harness issue list open
pnpm harness issue show 42
# 改动仓库且没有同题 Issue 时，先创建并记下返回的编号：
pnpm harness issue create "让用户能在主对话中查询提醒时间" < issue-body.md
```

Issue 可以是一段自然语言，不要求用户填表。`issue show` 返回正文、前 100 条评论、评论总数，以及当前分支带对应 `Refs: #N` 的本地提交。列表最多返回 50 条 Issue，不含 PR。读取使用 GitHub 公开 REST API，遇到限流尝试通过本机 `gh` 读取；创建、评论、关单、重开使用已登录的 `gh`，需要该仓库相应权限。遇到验证失败时在自己的终端运行 `gh auth login -h github.com`，不要把 token 写入项目。

```sh
git switch -c issue-42-reminder-status
# 实现后，仅暂存属于这次工作的改动；暂存前检查是否混有其他工作。
git add -p -- apps/api/src/service.ts
git diff --cached
pnpm test
pnpm harness commit create --issue 42 "fix: clarify reminder status" -- apps/api/src/service.ts
pnpm harness commit log --issue 42
pnpm harness commit show HEAD
```

`commit create` 不暂存文件。传入的路径集合必须与整个暂存区完全一致，否则退出且不提交；部分暂存文件的未暂存内容不会被带入。路径使用 `status` 返回的仓库相对路径；重命名需同时声明旧、新路径。提交时必须指定本仓库的真实 Issue。harness 在线核对编号后写入 `Refs: #42`；误填 PR 编号会中止提交。

```sh
pnpm harness commit push
pnpm harness pr submit --issue 42
pnpm harness issue comment 42 < delivery.md
# 有 Closes #42 的 PR 合入后会自动关单；其他情况确认解决后再关单。
# 问题复发时：
pnpm harness issue reopen 42
```

push 仅向目标仓库推送当前非 main/master 工作分支，不强推。发布、评论、关闭是三个独立操作。结果评论应说明用户可见变化、实际运行过的验证、提交链接和剩余限制；仅有本地 SHA 或分支推送不代表修改已经合并。创建和评论的结果包含 GitHub URL。网络错误可能发生在远端写入之后：先用 `issue list` / `issue show` 核对，不要自动重发。

## 轻量验证和自动合并

默认交付范围及例外见[仓库协作约定](../AGENTS.md)。先对照 Issue 的验收条件审阅完整差异，再执行 `commit push` 和回执里的 `pr submit --issue N`。这两个入口都会更新 `origin/main`，检查分支相对它新增的每个非合并提交，包括从其他工作分支合入的提交。每个提交都须有唯一的 `Refs: #N`，编号须一致。同步 main 带来的已合入提交会自动排除。报错给出有问题的提交号，可用 `pnpm harness commit show SHA` 核对内容，按任务放回各自分支。

新 PR 用 `Closes #N` 关联任务。复用 PR 时保留已有描述，缺少关联就补上。启用自动合并前，harness 核对 GitHub 实际标记为随 PR 关闭的 Issue，要求只有本项。总 Issue、前置任务和讨论背景均可用普通链接引用。用户要求仅评审时不执行 `pr submit`。

仓库启用 GitHub 原生 auto-merge，`main` 的活动规则集要求通过 PR 和 GitHub Actions 的 `lint` 检查（应用 ID `15368`）。GitHub 检出 PR 合并候选、按锁文件安装依赖、运行 `pnpm lint`。新提交触发新检查。harness 只为当前工作分支的 PR 申请自动合并，校验已推送的 HEAD，不使用管理员绕过；普通 PR 只自动验证，不自动申请合并。若分支落后且规则要求同步，请先更新分支再验证。

`pr submit` 启用自动合并后保持运行。每 15 秒查询该 PR 当前 HEAD 的状态；检查尚未登记、正在排队或已绿但尚未合并时都会继续等。状态变化写入 stderr；最终回执写入 stdout。只有 GitHub 确认此 PR `MERGED` 到 `main` 且返回 `mergeCommit.oid` 才以 0 退出。本仓库要求的 lint 只代表静态规则通过，仍应按改动验证功能。

**由提交 PR 的开发会话负责修复和接续。** `pnpm harness pr watch N` 可从仓库的任何工作树只读跟进同一 PR；`N` 是 PR 编号，不是 Issue 编号。关闭终端后不在后台运行，恢复会话时重新执行即可。

- `checks_failed`：回执含失败名称、结论及详情链接。打开失败作业，或用 `gh run view <run-id> --log-failed` 看日志。代码问题在原分支修复，验证、提交并 `commit push`；确认为临时基础设施故障才重跑失败作业。接着 `pr watch N` 看最新 HEAD，不重开 PR，也不以旧作业绿灯为准。
- `behind` / `conflicts`：在原工作分支同步 `origin/main`，按需解决冲突、验证并推送，然后继续监听。`auto_merge_off`：核对原因后，若仍应合并，在原分支重新执行 `pr submit --issue N`。
- `review`、`draft`、`closed` 或目标分支不符：回执非零退出，核对所需审批或原意。读取暂时失败会退避重试，连续三次失败或状态 30 分钟不变时交回会话诊断；处理后接续，不能据此宣称已合入。

## 分支清理

GitHub 仓库设置 **Automatically delete head branches** 已开启。合并 PR 后由 GitHub 删除同仓源分支（受保护分支仍受规则限制）。这个设置不会删除开发者机器上的 `refs/heads/*`。本仓库默认分支是 `main`。

默认按需清理本地分支。PR 合入后，在当前检出切回 `main` 并快进到最新的 `origin/main`，再运行：

```sh
pnpm harness branch cleanup --dry-run   # 预览将删除和保留的分支
pnpm harness branch cleanup             # 执行清理
```

有闲置分支时，harness 更新远端引用，再核对 GitHub 的合并记录。只有远端同名分支已消失、本地尖端等于已合并 PR 的尖端、且该提交已进入默认分支时，才会尝试 `git branch -d`。任何检出仍在使用的分支、`main` 和 `master` 都会保留。网络失败后可重新运行。

如果这台 Mac 以前配置过每五分钟清理一次，运行 `pnpm harness branch auto off` 会卸载本检出的登录项，并移除专用的脚本副本。可用 `pnpm harness branch auto status` 核对，卸载后 `installed` 和 `loaded` 均为 `false`。按需清理直接使用仓库里的脚本。
