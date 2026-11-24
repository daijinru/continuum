# 实施决策

- 本地环境为 macOS、Node 24.21.0、pnpm 10.4.1、Codex CLI 0.169.1，登录检查返回 ChatGPT 已登录。
- 采用单个 Fastify 进程持有 SQLite 写连接、调度器与实时通知。使用 Node 自带 SQLite 和显式 SQL 迁移。静态 React 资源与 API 同源。
- 从本机 CLI 生成 TypeScript 与 JSON Schema，协议升级需重新生成并验证。演示是独立适配器，模拟证据标明来源。
- 默认仅监听回环地址。真实执行由用户选定项目和提供方后启动。
