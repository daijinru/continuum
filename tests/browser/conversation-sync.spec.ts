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
