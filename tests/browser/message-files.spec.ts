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

test("助手回复中的本地图片可以预览、放大，刷新历史后仍可查看", async ({
  page,
}) => {
  const home = mkdtempSync(join(tmpdir(), "continuum-preview-"));
  const { app, s, worker } = await createServer({
    home,
    seed: false,
    worker: false,
    webDist: fileURLToPath(new URL("../../apps/web/dist/", import.meta.url)),
  });
  const raster = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhZkAAAAASUVORK5CYII=",
    "base64",
  );
  s.adapters.codex.start = async (ctx) => {
    mkdirSync(join(ctx.workspace, "图表"));
    writeFileSync(
      join(ctx.workspace, "图表", "流程 图.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="100" height="50"/></svg>',
    );
    writeFileSync(join(ctx.workspace, "结果.png"), raster);
    writeFileSync(join(home, "外部.png"), raster);
    symlinkSync(join(home, "外部.png"), join(ctx.workspace, "越界.png"));
    ctx.emit({ type: "run.started", key: "start", title: "开始" });
    ctx.emit({
      type: "agent.message",
      key: "reply",
      title:
        "![执行流程][chart]\n\n[chart]: <图表/流程 图.svg>\n\n截图：结果.png。\n\n![遗失](旧图.png) ![目录外](越界.png)",
    });
    ctx.emit({ type: "run.completed", key: "done", title: "结束" });
  };
  try {
    s.commission("交付图表", crypto.randomUUID());
    await worker.tick();
    const url = await app.listen({ host: "127.0.0.1", port: 0 });
    await page.goto(url + "/#chat");
    for (let visit = 0; visit < 2; visit++) {
      const plot = page.getByRole("button", { name: "查看原图：执行流程" });
      await expect(plot.getByRole("img")).toHaveJSProperty("naturalWidth", 120);
      await plot.click();
      await expect(page.getByRole("dialog").getByRole("img")).toHaveJSProperty(
        "naturalWidth",
        120,
      );
      await page.keyboard.press("Escape");
      await expect(
        page
          .getByRole("button", { name: "查看原图：结果.png" })
          .getByRole("img"),
      ).toHaveJSProperty("naturalWidth", 1);
      await expect(
        page.getByRole("button", { name: "结果.png", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("遗失（无法预览，请检查原文件）"),
      ).toBeVisible();
      await expect(
        page.getByText("目录外（无法预览，请检查原文件）"),
      ).toBeVisible();
      if (!visit) await page.reload();
    }
  } finally {
    await page.close();
    await app.close();
    rmSync(home, { recursive: true, force: true });
  }
});
