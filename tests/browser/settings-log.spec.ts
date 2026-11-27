import { expect, test } from "@playwright/test";

test("日志列表未加载时也能打开文件夹，失败时显示当前实例的目录", async ({ page, request }) => {
  const { data: settings } = await (await request.get("/api/v1/settings")).json();
  let attempts = 0;
  await page.route("**/api/v1/conversation/log/open-folder", route => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toEqual({});
    attempts++;
    return attempts === 1
      ? route.fulfill({ status: 503, json: { error: "未能打开日志文件夹" } })
      : route.fulfill({ json: { data: true } });
  });
  await page.goto("/#settings");
  const viewer = page.getByRole("region", { name: "主对话日志" });
  const open = viewer.getByRole("button", { name: "打开日志文件夹" });
  await open.click();
  await expect(viewer.getByRole("alert")).toContainText(settings.db);
  await open.click();
  await expect(open).toBeEnabled();
  await expect(viewer.getByRole("alert")).toHaveCount(0);
  expect(attempts).toBe(2);
  await expect(viewer.getByRole("button", { name: "查看日志" })).toBeVisible();
});

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
