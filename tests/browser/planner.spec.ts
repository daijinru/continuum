import { expect, test } from "@playwright/test";

test("Planner 个人任务流转、刷新、筛选和统计", async ({ page }) => {
  await page.goto("/#planner");
  await page.getByLabel("任务名称").fill("交付复核");
  await page.getByLabel("负责人", { exact: true }).fill("Lin");
  await page.getByLabel("截止日期").fill("2020-01-01");
  await page.getByRole("button", { name: "添加个人任务" }).click();
  await expect(page.getByText(/当前结果 1 项.*逾期 1/)).toBeVisible();
  await page.getByRole("combobox", { name: /移动任务/ }).selectOption("已完成");
  await page.reload();
  const done = page
    .locator(".lane")
    .filter({ has: page.getByRole("heading", { name: "已完成（1）" }) });
  await expect(done.getByText("交付复核")).toBeVisible();
  await page.getByLabel("搜索").fill("lin");
  await page.getByLabel("阶段", { exact: true }).selectOption("进行中");
  await expect(page.getByText(/当前结果 0 项/)).toBeVisible();
  await page.getByRole("button", { name: "清空筛选" }).click();
  await expect(page.getByText(/逾期 0 · 完成率 100%/)).toBeVisible();
});
