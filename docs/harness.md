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
