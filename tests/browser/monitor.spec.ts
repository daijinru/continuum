import { expect, test } from "@playwright/test";

test("从本机状态进入监测器，展开进程并定位委托；失败不显示零占用", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("link", { name: /运行监测/ }).click();
  await expect(page.getByRole("heading", { name: "运行监测" })).toBeVisible();
  await page.getByText("查看进程明细").click();
  await expect(page.getByText("工作台服务与调度器")).toBeVisible();
  await page.getByRole("link", { name: "开发战棋游戏原型" }).click();
  await expect(
    page.getByRole("heading", { name: "开发战棋游戏原型" }),
  ).toBeVisible();
  await page.route("**/api/v1/system/monitor", (route) =>
    route.fulfill({
      json: {
        data: {
          sampledAt: new Date().toISOString(),
          processes: null,
          tasks: [],
        },
      },
    }),
  );
  await page.goto("/#monitor");
  await expect(
    page.getByText("本次无法读取进程占用", { exact: false }),
  ).toBeVisible();
  await expect(page.getByText("CPU 0%", { exact: false })).toHaveCount(0);
});
