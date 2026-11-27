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
