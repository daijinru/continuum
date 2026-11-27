import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../apps/api/src/server.ts";
import type { Context } from "../../packages/agent-core/src/index.ts";

test("主对话空闲时，执行中的即时消息、审批和别项交付依次上屏", async ({
  page,
}) => {
  const { app, s, worker } = await createServer({
    home: mkdtempSync(join(tmpdir(), "continuum-live-page-")),
    worker: false,
    seed: false,
  });
  const runs: Context[] = [];
  s.adapters.codex.start = async (ctx) => {
    runs.push(ctx);
    ctx.emit({ type: "run.started", key: "start", title: "开始" });
  };
  try {
    const url = await app.listen({ host: "127.0.0.1", port: 0 });
    await page.goto(url + "/#chat");
    await expect(page.getByText("本地服务在线")).toBeAttached();
    s.commission("长委托", crypto.randomUUID());
    await worker.tick();
    const [long] = runs;
    long.emit({
      type: "agent.message",
      key: "async",
      title: "样稿准备好了",
      data: { delivery: "async" },
    });
    await expect(
      page.getByText("样稿准备好了", { exact: true }),
    ).toBeInViewport();
    long.emit({
      type: "approval.requested",
      key: "decision",
      title: "核对样稿",
      approval: {
        id: "sample",
        action: "查看文件",
        reason: "需要决定",
        scope: "合成样稿",
        risk: "低",
      },
    });
    await expect(page.getByRole("link", { name: "去处理" })).toBeInViewport();
    s.commission("短委托", crypto.randomUUID());
    await worker.tick();
    const short = runs[1];
    short.emit({ type: "agent.message", key: "final", title: "短委托已交付" });
    short.emit({ type: "run.completed", key: "end", title: "结束" });
    await expect(
      page.getByText("短委托已交付", { exact: true }),
    ).toBeInViewport();
    expect(s.run(long.id).finished).toBeNull();
    long.emit({ type: "agent.message", key: "final", title: "长委托已交付" });
    long.emit({ type: "run.completed", key: "end", title: "结束" });
    await expect(
      page.getByText("长委托已交付", { exact: true }),
    ).toBeInViewport();
  } finally {
    await page.close();
    await app.close();
  }
});
