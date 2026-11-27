import { expect, test } from "@playwright/test";
import type { WorkStatus } from "../../packages/contracts/src/monitor.ts";

test("主对话自动更新委托提示，窄屏可直达决定和执行记录", async ({ page, request }) => {
  const [item] = (await (await request.get("/api/v1/inbox")).json()).data;
  let status: WorkStatus = { kind: "decision", count: 1, targetId: item.id };
  await page.route("**/api/v1/conversation/work-status", route => route.fulfill({ json: { data: status } }));
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/#chat");
  await expect(page.getByRole("link", { name: "今日简报" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  await page.getByRole("link", { name: "1 项待你决定" }).click();
  await expect(page).toHaveURL(new RegExp("#inbox/" + item.id + "$"));
  await expect(page.locator(".work-status")).toHaveCount(0);

  status = { kind: "working", count: 1, targetId: item.goal_id };
  await page.goto("/#chat");
  const link = page.locator(".work-status");
  await expect(link).toHaveAttribute("href", "#goal/" + item.goal_id);
  await expect(link).toHaveText("1 项执行中");
  status = { kind: "working", count: 2, targetId: null };
  await expect(link).toHaveText("2 项执行中", { timeout: 9000 });
  await expect(link).toHaveAttribute("href", "#monitor");
  status = { kind: "decision", count: 2, targetId: null };
  await expect(link).toHaveAttribute("href", "#inbox", { timeout: 9000 });
  status = null;
  await expect(link).toHaveCount(0, { timeout: 9000 });
});

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
