# Codex 协议记录

验证版本为 `codex-cli 0.169.1`。本机命令行报告已通过 ChatGPT 登录；实际验收还完成了初始化、账号读取和模型轮次。

```sh
codex --version
codex login status
codex app-server generate-ts --out packages/codex-adapter/generated
codex app-server generate-json-schema --out packages/codex-adapter/schema
pnpm typecheck
pnpm test
pnpm test:codex
```

后端通过参数数组启动 `codex app-server --stdio`。客户端发出 initialize，成功后发送 initialized。RPC 超时为 30 秒，进程退出会终止未完成的客户端请求。服务端主动发出的请求使用自己的编号空间。审批答复保留原编号的字符串或数字类型。

| 操作 | 方法与处理 |
| --- | --- |
| 确认账号 | account/read，检查返回的账号对象 |
| 新目标 / 继续原线程 | thread/start 或 thread/resume，随后 turn/start |
| 状态和证据 | turn/started、thread/status/changed、turn/plan/updated、item/started、item/completed、turn/completed |
| 本次审批 | item/commandExecution/requestApproval、item/fileChange/requestApproval，返回 accept 或 decline |
| 人工输入 | item/tool/requestUserInput，按每个问题的原 id 返回 answers。秘密输入及不可完整展示的请求拒绝接收 |
| 撤销待批请求 | serverRequest/resolved，关闭仍然有效的本地请求 |
| 中断 | turn/interrupt，等待提供方报告终态 |
| 恢复 | thread/read 携带 includeTurns，按原 turn id 匹配并补入可确认的事项 |

本机生成的协议类型是实现的编译依据。升级 CLI 后先重新生成类型，再跑协议和真实任务测试。当前真实验收验证了文件补丁审批、继续线程、最终文件与简报证据。参考 [OpenAI App Server 官方文档](https://learn.chatgpt.com/docs/app-server)。

