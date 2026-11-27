import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "../../apps/api/src/server.ts";
import type { Context } from "../../packages/agent-core/src/index.ts";

test("主对话空闲时，执行中的即时消息、审批和别项交付依次上屏", async ({
  page,
}) => {
  const { app, s, worker } = await createServer({
    home: mkdtempSync(join(tmpdir(), "continuum-live-page-")),
    webDist: fileURLToPath(new URL("../../apps/web/dist/", import.meta.url)),
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
    const progress = page.getByRole("region", { name: "运行进展" });
    const longRow = progress.getByRole("link", { name: /长委托/ });
    long.emit({ type: "agent.message", key: "first", title: "正在核对第一份样稿" });
    await expect(longRow).toHaveText(/正在核对第一份样稿/);
    long.emit({ type: "agent.message", key: "second", title: "正在核对第二份样稿" });
    await expect(longRow).toHaveText(/正在核对第二份样稿/);
    await expect(page.getByText("正在核对第一份样稿")).toHaveCount(0);
    s.commission("短委托", crypto.randomUUID());
    await worker.tick();
    const short = runs[1];
    short.emit({ type: "agent.message", key: "check", title: "正在核对日期" });
    await page.reload();
    await expect(longRow).toHaveAttribute("href", "#run/" + long.id);
    await expect(progress.getByRole("link")).toHaveCount(2);
    await expect(progress.getByRole("link", { name: /短委托/ })).toContainText("正在核对日期");
    await expect(page.locator("article").filter({ hasText: "正在核对第二份样稿" })).toHaveCount(0);
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
    await expect(longRow).toHaveCount(0);
    short.emit({ type: "agent.message", key: "final", title: "短委托已交付" });
    short.emit({ type: "run.completed", key: "end", title: "结束" });
    await expect(
      page.getByText("短委托已交付", { exact: true }),
    ).toBeInViewport();
    await expect(progress).toHaveCount(0);
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
