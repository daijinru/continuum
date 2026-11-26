import { expect, test } from "@playwright/test";

test("从主对话查看工作台用量，再查看单项委托", async ({ page, request }) => {
  const goals = (await (await request.get("/api/v1/goals")).json()).data;
  await page.goto("/");
  await page.getByRole("link", { name: "查看主对话 token 用量明细" }).click();
  await expect(page.getByText("工作台合计")).toBeVisible();
  await expect(page.getByText("主对话 · 理解消息")).toBeVisible();
  await expect(page.getByText("全部委托 · 执行与筛选")).toBeVisible();
  await page.goto("/#goal/" + goals[0].id);
  await page.getByRole("button", { name: "管理委托" }).click();
  await expect(page.getByText("本项委托的 token 用量")).toBeVisible();
  await expect(page.getByText("暂无记录", { exact: true })).toBeVisible();
});
