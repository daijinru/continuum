import { test, expect } from "@playwright/test";

test("打开设置时按需查看模型目录、执行档位与用量", async ({ page }) => {
  let reads = 0;
  await page.route("**/api/v1/models", (route) => {
    reads++;
    const model = "sample-text";
    return route.fulfill({
      json: {
        data: {
          models: [
            { id: model, name: model, efforts: ["low", "medium", "high"] },
          ],
          choices: {
            light: { model, effort: "low" },
            standard: { model, effort: "medium" },
            deep: { model, effort: "high" },
          },
          recent: [
            {
              kind: "筛选",
              workload: "light",
              model,
              effort: "low",
              fallback: 0,
              started: "2026-11-26T09:00:00Z",
              finished: "2026-11-26T09:00:02Z",
              total: 123,
              outcome: "succeeded",
            },
          ],
        },
      },
    });
  });
  await page.goto("/#settings");
  const toggle = page.getByText("自动选模与用量记录", { exact: true });
  await expect(toggle).toBeVisible();
  expect(reads).toBe(0);
  await toggle.click();
  await expect(page.getByText(/2\.0 秒.*123 tokens/)).toBeVisible();
  await page.getByText("可用文本模型（1）").click();
  await expect(
    page.getByText("sample-text · low / medium / high"),
  ).toBeVisible();
});

test("紧凑和详细委托列表显示最近一轮模型、用量和耗时", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-11-26T08:59:00Z") });
  await page.clock.pauseAt(new Date("2026-11-26T09:00:05Z"));
  await page.setViewportSize({ width: 390, height: 844 });
  const goal = {
    description: "",
    provider: "codex",
    state: "active",
    updated: "2026-11-26T09:00:00Z",
    latestCreated: "2026-11-26T09:00:00Z",
    latestFinished: null,
    latestTokens: null,
  };
  await page.route("**/api/v1/goals", (route) =>
    route.fulfill({
      json: {
        data: [
          {
            ...goal,
            id: "one",
            title: "核对数据",
            latest: "running",
            latestModel: "sample-deep",
            latestEffort: "high",
            latestTokens: 0,
          },
          {
            ...goal,
            id: "two",
            title: "旧委托",
            latest: "succeeded",
            latestTokens: 1234,
            latestFinished: "2026-11-26T09:01:13Z",
            latestModel: null,
            latestEffort: null,
          },
          {
            ...goal,
            id: "lost",
            title: "待核对",
            latest: "unknown",
          },
          {
            ...goal,
            latestCreated: null,
            id: "three",
            title: "新委托",
            latest: null,
            latestModel: null,
            latestEffort: null,
          },
        ],
      },
    }),
  );
  await page.goto("/#goals");
  for (const view of ["紧凑视图", "详细视图"]) {
    await page.getByRole("button", { name: view }).click();
    await expect(page.locator('a[href="#goal/one"]')).toContainText(
      "最近一轮 · sample-deep · 推理强度 high · 0 tokens · 已用时 5.0 秒",
    );
    await expect(page.locator('a[href="#goal/two"]')).toContainText(
      "模型未记录 · 推理强度未记录 · 1,234 tokens · 耗时 1 分 13 秒",
    );
    await expect(page.locator('a[href="#goal/lost"]')).toContainText("用量未报告 · 耗时待确认");
    await expect(page.locator('a[href="#goal/three"]')).not.toContainText(
      "最近一轮",
    );
  }
  await page.clock.fastForward(2000);
  await expect(page.locator('a[href="#goal/one"]')).toContainText("已用时 7.0 秒");
  await expect(page.locator('a[href="#goal/two"]')).toContainText("耗时 1 分 13 秒");
});
