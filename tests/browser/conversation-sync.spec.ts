import { expect, test } from "@playwright/test";

test("空闲时不读消息，另一页面发送后通过实时通知补齐", async ({ page, request }) => {
  let full = 0, changes = 0;
  page.on("request", req => {
    const path = new URL(req.url()).pathname;
    if (path === "/api/v1/conversation") full++;
    if (path === "/api/v1/conversation/changes") changes++;
  });
  await page.goto("/#chat");
  await expect(page.getByText("本地服务在线")).toBeAttached();
  await expect.poll(() => full).toBe(1);
  await page.waitForTimeout(2800);
  expect(full).toBe(1);
  const reads = changes;
  await page.waitForTimeout(2700);
  expect(changes).toBe(reads);
  const { data } = await (await request.get("/api/v1/session")).json();
  const response = await request.post("/api/v1/conversation/messages", {
    headers: { "X-Continuum-Token": data.token },
    data: { key: crypto.randomUUID(), text: "现在都怎么样了？" },
  });
  expect(response.ok()).toBeTruthy();
  await expect.poll(() => changes).toBeGreaterThan(reads);
  await expect(page.locator("article.user").last()).toContainText("现在都怎么样了？");
  expect(full).toBe(1);
});

test("本地日志关联到真正进入可见区域的后台回复", async ({ page, request }) => {
  const { DatabaseSync } = await import("node:sqlite");
  const { join } = await import("node:path");
  const status = (await (await request.get("/api/v1/system/status")).json()).data;
  const db = new DatabaseSync(join(status.db, "continuum.sqlite"), { readOnly: true });
  try {
    await page.goto("/#chat");
    const sending = page.waitForRequest(r => r.url().endsWith("/conversation/messages") && r.method() === "POST");
    await page.getByRole("button", { name: "问进度" }).click();
    const key = (await sending).postDataJSON().key;
    await expect.poll(() => db.prepare(
      "SELECT count(*) n FROM conversation_log WHERE stage='on_screen' AND message_id IN (SELECT id FROM main_messages WHERE kind='status' AND reply_to=?)",
    ).get(key)?.n).toBeGreaterThan(0);
    const seen = db.prepare(`SELECT l.page_id,m.id,m.reply_to FROM conversation_log l JOIN main_messages m ON m.id=l.message_id
      WHERE l.stage='on_screen' AND m.kind='status' AND m.reply_to=? ORDER BY l.seq DESC LIMIT 1`).get(key)!;
    const stages = db.prepare("SELECT stage FROM conversation_log WHERE message_id=?").all(seen.reply_to)
      .map(row => row.stage);
    expect(stages).toEqual(expect.arrayContaining(["received","handling","committed"]));
    const changed = db.prepare("SELECT max(version) v FROM conversation_log WHERE stage='committed' AND message_id=?").get(seen.id)!;
    await expect.poll(() => db.prepare("SELECT DISTINCT stage FROM conversation_log WHERE page_id=? AND version>=?")
      .all(seen.page_id,changed.v).map(r => r.stage)).toEqual(expect.arrayContaining(["stream_write","notice","applied"]));
  } finally { db.close(); }
});
