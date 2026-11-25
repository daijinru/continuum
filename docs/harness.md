# 仓库开发 harness · v1

面向维护 `daijinru/continuum` 的人和 coding agent。`AGENTS.md` 定义协作约定；`scripts/harness.ts` 提供可验证的操作。它使用 Git 的真实暂存区、提交 SHA 和 GitHub Issue 编号，没有另一套工单数据库。仓库中可运行 `pnpm harness --help`；程序消费 JSON 时使用 `node scripts/harness.ts …`（避免 pnpm 命令横幅）。

## 从问题到交付

以下 `42`、分支、路径和正文都是示例，不会自动执行。

```sh
pnpm harness status
pnpm harness issue list open
pnpm harness issue show 42
# 确实缺少 Issue 并且需要公开跟踪时：
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

`commit create` 不暂存文件。传入的路径集合必须与整个暂存区完全一致，否则退出且不提交；部分暂存文件的未暂存内容不会被带入。路径使用 `status` 返回的仓库相对路径；重命名需同时声明旧、新路径。不关联 Issue 的本地维护可以省略 `--issue 42`。编号是提交关联标记，不以 GitHub 在线作为创建本地提交的前提。

```sh
pnpm harness commit push
pnpm harness issue comment 42 < delivery.md
pnpm harness issue close 42
# 问题复发时：
pnpm harness issue reopen 42
```

push 仅向目标仓库推送当前非 main/master 工作分支，不强推。发布、评论、关闭是三个独立操作。结果评论应说明用户可见变化、实际运行过的验证、提交链接和剩余限制；仅有本地 SHA 或分支推送不代表修改已经合并。创建和评论的结果包含 GitHub URL。网络错误可能发生在远端写入之后：先用 `issue list` / `issue show` 核对，不要自动重发。

## 轻量验证和自动合并

受托交付 PR 时，先检查本分支相对 `main` 的**全部已提交改动**，然后推送并运行回执中 `next` 给出的 `pnpm harness pr submit`。如果 HEAD 有唯一的 `Refs: #42` 尾注，回执会带上 `--issue 42`，首次创建时将 `Closes #42` 写入新 PR。已有 PR 会复用，保留其描述与关单约定。用户要求仅评审时不执行 `pr submit`。工作区中的未提交修改不会进 PR。

仓库启用 GitHub 原生 auto-merge，`main` 的活动规则集要求通过 PR 和 GitHub Actions 的 `lint` 检查（应用 ID `15368`）。GitHub 检出 PR 合并候选、按锁文件安装依赖、运行 `pnpm lint`。新提交触发新检查。harness 只为当前工作分支的 PR 申请自动合并，校验已推送的 HEAD，不使用管理员绕过；普通 PR 只自动验证，不自动申请合并。若分支落后且规则要求同步，请先更新分支再验证。

早期默认只用 lint，不要求回归测试或人工批准。lint 通过仅代表符合静态规则，不等于功能正确。变更涉及迁移、权限或用户流程时，按变更选做针对性验证。用 `gh pr view <编号> --json state,mergeCommit,statusCheckRollup` 区分等待检查与已合并。

## 分支清理

GitHub 仓库设置 **Automatically delete head branches** 已开启。合并 PR 后由 GitHub 删除同仓源分支（受保护分支仍受规则限制）。这个设置不会删除开发者机器上的 `refs/heads/*`。本仓库默认分支是 `main`。

```sh
pnpm harness branch auto on          # 本机 macOS、此检出安装/更新一次
pnpm harness branch auto status
pnpm harness branch cleanup --dry-run
pnpm harness branch cleanup         # 立即执行；其他系统也可以定时运行
pnpm harness branch auto off
```

本地任务使用用户级 LaunchAgent，登录后及每 5 分钟检查；依赖已登录的 `gh`、Git 和 Node。若有待核对的闲置工作分支，先 `fetch --prune`，再核对 GitHub 上已合并到默认分支的同仓 PR。**只有远端同名分支已消失、PR head 等于本地尖端、该提交是远端默认分支的祖先时，才尝试 `git branch -d`**。该策略匹配 harness 的普通 merge；不能证明等价的 squash/rebase 不自动清理。网络失败就留待下轮。

后台不切换任何工作树。PR 合并后，在原工作树自行 `git switch main`、`git pull --ff-only`；不再有 worktree 占用的分支会在下一轮清理。`main`/`master`、含未合入提交的分支、当前及其他工作树正在使用的分支均保留。安装时把清理程序复制到此仓库 Git 公共目录，切换分支不影响定时任务；脚本升级或仓库移动后重新安装。
