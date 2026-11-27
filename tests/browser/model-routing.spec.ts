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

test("紧凑和详细委托列表直接显示最近一轮模型与推理强度", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const goal = {
    description: "",
    provider: "codex",
    state: "active",
    updated: "2026-11-26T09:00:00Z",
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
          },
          {
            ...goal,
            id: "two",
            title: "旧委托",
            latest: "succeeded",
            latestModel: null,
            latestEffort: null,
          },
          {
            ...goal,
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
      "最近一轮 · sample-deep · 推理强度 high",
    );
    await expect(page.locator('a[href="#goal/two"]')).toContainText(
      "模型未记录 · 推理强度未记录",
    );
    await expect(page.locator('a[href="#goal/three"]')).not.toContainText(
      "最近一轮",
    );
  }
});
