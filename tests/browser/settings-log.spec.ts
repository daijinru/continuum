import { expect, test } from "@playwright/test";

test("查看主对话日志，刷新失败后可以重试并展开关联标识", async ({ page, request }) => {
  const path = "/api/v1/conversation/log";
  let reads = 0;
  await page.route("**" + path, route => {
    if (route.request().method() === "GET") {
      reads++;
      if (reads === 1) return route.fulfill({ json: { data: [] } });
      if (reads === 2) return route.fulfill({ status: 503, json: { error: "读取失败" } });
    }
    return route.continue();
  });
  await page.goto("/#settings");
  const viewer = page.getByRole("region", { name: "主对话日志" });
  await expect(viewer).toBeVisible();
  expect(reads).toBe(0);
  await viewer.getByRole("button", { name: "查看日志" }).click();
  await expect(viewer.getByRole("status")).toHaveText("暂无主对话日志。");
  const refresh = viewer.getByRole("button", { name: "刷新日志" });
  await refresh.click();
  await expect(viewer.getByRole("status")).toContainText("读取失败");

  const { data } = await (await request.get("/api/v1/session")).json();
  const pageId = crypto.randomUUID(), message = crypto.randomUUID();
  const response = await request.post(path, {
    headers: { "X-Continuum-Token": data.token },
    data: { page: pageId, events: [{ stage: "send_failed", at: new Date().toISOString(), message, version: 0 }] },
  });
  expect(response.ok()).toBeTruthy();
  await refresh.click();
  const row = viewer.locator("details").filter({ hasText: message });
  await row.locator("summary").click();
  await expect(row.locator("summary")).toContainText("消息发送失败");
  await expect(row.getByText(pageId)).toBeVisible();
  await expect(row.getByText("0", { exact: true })).toBeVisible();
  await expect(viewer.getByRole("status")).toHaveCount(0);
});
