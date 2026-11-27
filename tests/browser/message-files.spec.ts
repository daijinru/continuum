import { expect, test } from "@playwright/test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "../../apps/api/src/server.ts";

test("从主对话打开本轮文件，重载后仍可打开，并说明文件已移除", async ({
  page,
}) => {
  const home = mkdtempSync(join(tmpdir(), "continuum-files-"));
  const opened: string[] = [];
  const { app, s, worker, token } = await createServer({
    home,
    seed: false,
    worker: false,
    webDist: fileURLToPath(new URL("../../apps/web/dist/", import.meta.url)),
    openDocument: async (path) => {
      opened.push(readFileSync(path, "utf8"));
    },
  });
  const name = "文章汇总-2026-11-27.md";
  let path = "";
  s.adapters.codex.start = async (ctx) => {
    mkdirSync(join(ctx.workspace, "reports"));
    path = join(ctx.workspace, "reports", name);
    writeFileSync(path, "本轮交付内容");
    writeFileSync(join(ctx.workspace, name), "另一个同名文件");
    writeFileSync(join(ctx.workspace, "周报 草稿.md"), "未单独登记的草稿");
    writeFileSync(join(home, "outside.md"), "目录外");
    symlinkSync(join(home, "outside.md"), join(ctx.workspace, "链接.md"));
    ctx.emit({ type: "run.started", key: "start", title: "开始" });
    ctx.emit({ type: "file.changed", key: "file", title: "已写入", path });
    ctx.emit({
      type: "agent.message",
      key: "async",
      title: "初稿 [点此查看](<周报 草稿.md>)",
      data: { delivery: "async" },
    });
    ctx.emit({
      type: "agent.message",
      key: "final",
      title:
        "已整理并保存：" +
        name +
        "。\n\n" +
        "本轮说明。".repeat(170) +
        "\n\n另见 `链接.md` 和 [网站](https://example.com/info.md)。",
    });
    ctx.emit({ type: "run.completed", key: "end", title: "结束" });
  };
  try {
    s.commission("整理文章", crypto.randomUUID());
    await worker.tick();
    const url = await app.listen({ host: "127.0.0.1", port: 0 });
    await page.goto(url + "/#chat");
    await page.getByRole("button", { name: "点此查看" }).click();
    await expect.poll(() => opened.at(-1)).toBe("未单独登记的草稿");
    await page.getByRole("button", { name, exact: true }).click();
    await expect.poll(() => opened.at(-1)).toBe("本轮交付内容");
    await page.reload();
    await page.getByText("阅读全文", { exact: true }).click();
    await page.getByRole("button", { name, exact: true }).click();
    await expect.poll(() => opened.length).toBe(3);
    await expect(page.getByRole("link", { name: "网站" })).toHaveAttribute(
      "href",
      "https://example.com/info.md",
    );
    await page.getByRole("button", { name: "链接.md" }).click();
    await expect(page.getByRole("alert")).toContainText("找不到文件");
    const id = await page
      .locator(".chat-row")
      .filter({ has: page.getByRole("button", { name, exact: true }) })
      .getAttribute("data-message-id");
    const unmentioned = await page.request.post(
      url + "/api/v1/conversation/messages/" + id + "/open-file",
      {
        headers: { "X-Continuum-Token": token },
        data: { path: "outside.md" },
      },
    );
    expect(unmentioned.status()).toBe(404);
    rmSync(path);
    await page.getByRole("button", { name, exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("可能已移动或删除");
    expect(opened).toHaveLength(3);
  } finally {
    await page.close();
    await app.close();
    rmSync(home, { recursive: true, force: true });
  }
});
