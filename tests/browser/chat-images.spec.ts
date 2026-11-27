import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "../../apps/api/src/server.ts";

async function paste(page: Page) {
  return page
    .getByRole("textbox", { name: "发到主对话" })
    .evaluate(async (el) => {
      const canvas = document.createElement("canvas");
      canvas.width = 90;
      canvas.height = 40;
      canvas.getContext("2d")!.fillText("图中 85", 10, 20);
      const data = canvas.toDataURL();
      const blob = await new Promise<Blob>((resolve) =>
        canvas.toBlob((value) => resolve(value!)),
      );
      const clipboardData = new DataTransfer();
      clipboardData.items.add(
        new File([blob], "clipboard.png", { type: blob.type }),
      );
      el.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData,
        }),
      );
      return data;
    });
}

test("粘贴、移除、发送截图；历史与执行器收到相同的原图", async ({ page }) => {
  const home = mkdtempSync(join(tmpdir(), "continuum-image-paste-"));
  const { app, db, s, worker } = await createServer({
    home,
    worker: false,
    seed: false,
    webDist: fileURLToPath(new URL("../../apps/web/dist/", import.meta.url)),
  });
  const received: string[][] = [];
  s.adapters.codex.start = async (ctx) => {
    received.push(ctx.imageUrls ?? []);
    ctx.emit({ type: "run.started", key: "start", title: "开始" });
    ctx.emit({ type: "agent.message", key: "answer", title: "已分析图片" });
    ctx.emit({ type: "run.completed", key: "end", title: "完成" });
  };
  try {
    const url = await app.listen({ host: "127.0.0.1", port: 0 });
    await page.goto(url + "/#chat");
    const send = page.getByRole("button", { name: "发送", exact: true });
    await paste(page);
    await page.getByRole("button", { name: "移除图片 1" }).click();
    await expect(send).toBeDisabled();
    for (const caption of ["", "读图"]) {
      const data = await paste(page);
      await expect(page.getByAltText("待发送图片 1")).toBeVisible();
      await page.reload();
      await expect(page.getByAltText("待发送图片 1")).toBeVisible();
      await page.getByRole("textbox", { name: "发到主对话" }).fill(caption);
      await send.click();
      await expect
        .poll(
          () => db.all("SELECT id FROM main_messages WHERE role='user'").length,
        )
        .toBe(received.length + 1);
      await worker.tick();
      expect(received.at(-1)).toEqual([data]);
      await page.reload();
      const button = page
        .getByRole("button", { name: "查看原图：发送的图片 1" })
        .last();
      await button.click();
      await expect(page.getByRole("dialog").getByRole("img")).toHaveJSProperty(
        "naturalWidth",
        90,
      );
      await page.getByRole("button", { name: "关闭", exact: true }).click();
    }
  } finally {
    await page.close();
    await app.close();
    rmSync(home, { recursive: true, force: true });
  }
});
