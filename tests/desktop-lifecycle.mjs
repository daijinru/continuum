import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createSocket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { _electron } from "@playwright/test";
import { createServer } from "../apps/api/src/server.ts";
import { MainConversation } from "../apps/api/src/main-conversation.ts";

const temporary = await mkdtemp(join(tmpdir(), "continuum-desktop-test-"));
const data = join(temporary, "data");
const fixture = await createServer({ home: data, worker: false, seed: false });
const due = Date.now() + 30000;
try {
  const conversation = new MainConversation(fixture.s, async () => [
    {
      type: "reminder",
      text: "桌面关窗验收",
      at: "2099-03-21T10:00",
      cadence: "once",
      notify: "always",
      target: "",
    },
  ]);
  await conversation.send({
    key: crypto.randomUUID(),
    text: "提醒我验收桌面端",
  });
  assert.equal(
    fixture.db.run(
      "UPDATE main_tasks SET next_at=? WHERE mode='reminder'",
      new Date(due).toISOString(),
    ).changes,
    1,
  );
} finally {
  await fixture.app.close();
}

async function until(check, timeout = 15000) {
  const deadline = Date.now() + timeout;
  do {
    if (await check()) return;
    await delay(150);
  } while (Date.now() < deadline);
  throw Error("等待桌面状态变化超时");
}

const bin = resolve(
  "apps/desktop/dist/Continuum-darwin-" + process.arch,
  "Continuum.app/Contents/MacOS/Continuum",
);
const socket = createSocket();
await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
const port = String(socket.address().port);
await new Promise((resolve) => socket.close(resolve));
const desktop = await _electron.launch({
  executablePath: bin,
  args: ["--user-data-dir=" + join(temporary, "profile")],
  cwd: temporary,
  env: {
    ...process.env,
    PORT: port,
    CONTINUUM_DATA: data,
    CONTINUUM_SEED: "0",
  },
});
try {
  const page = await desktop.firstWindow();
  await page.locator("textarea").first().waitFor();
  assert.equal(
    await page.evaluate(() => "continuumDevUpdate" in window),
    false,
  );
  assert.equal(
    await page.getByRole("button", { name: "立即重启更新" }).count(),
    0,
  );
  const favicon = await page.locator('link[rel="icon"]').getAttribute("href");
  assert.equal(favicon, "/favicon.png");
  const iconWidth = await page.evaluate(async (url) => {
    const icon = new Image();
    icon.src = url;
    await icon.decode();
    return icon.naturalWidth;
  }, favicon);
  assert.equal(iconWidth, 64);
  const url = new URL(page.url()).origin;
  const monitor = await (await fetch(url + "/api/v1/system/monitor")).json();
  const pid = monitor.data.processes.find((p) => p.role === "service").pid;
  await desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].close(),
  );
  assert.ok(Date.now() < due, "必须在提醒到期前关窗");
  const windows = () =>
    desktop.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    );
  await until(async () => (await windows()) === 0);
  assert.ok(Date.now() < due);
  const db = new DatabaseSync(join(data, "continuum.sqlite"), {
    readOnly: true,
  });
  const delivered = () =>
    db.prepare("SELECT created FROM main_messages WHERE kind='reminder'").all();
  try {
    await until(() => delivered().length === 1, 40000);
    assert.ok(Date.parse(delivered()[0].created) >= due);
    assert.equal(await windows(), 0);
    console.log("关窗后，定时委托在后台完成，并只交付一次。");
    process.kill(pid, "SIGKILL");
    await until(async () => {
      try {
        const current = await (
          await fetch(url + "/api/v1/system/monitor")
        ).json();
        return current.data.processes.some(
          (p) => p.role === "service" && p.pid !== pid,
        );
      } catch {
        return false;
      }
    });
    assert.equal(await windows(), 0);
    const opening = desktop.waitForEvent("window");
    await desktop.evaluate(({ app }) => {
      app.emit("activate");
    });
    const reopened = await opening;
    await reopened
      .getByText(/到时间了.*桌面关窗验收/)
      .first()
      .waitFor({ timeout: 10000 });
    assert.equal(delivered().length, 1);
    const next = new URL(reopened.url()).origin;
    const snapshot = await (
      await fetch(next + "/api/v1/system/monitor")
    ).json();
    const successor = snapshot.data.processes.find(
      (p) => p.role === "service",
    ).pid;
    assert.notEqual(successor, pid);
    console.log("服务进程异常退出后自动恢复，重新打开窗口可见同一条交付。");
    await desktop.close();
    await assert.rejects(fetch(next + "/api/v1/health"));
    assert.throws(() => process.kill(successor, 0), { code: "ESRCH" });
  } finally {
    db.close();
  }
  const restarted = await createServer({
    home: data,
    worker: false,
    seed: false,
  });
  await restarted.app.close();
  console.log("完全退出后服务已退出、端口已释放，原数据目录可重新取得写锁。");
} finally {
  await desktop.close().catch(() => {});
  await rm(temporary, { recursive: true, force: true });
}
