import { expect, test } from "@playwright/test";

test("待处理的操作可选择本轮授权，历史显示授权范围", async ({ page }) => {
  const id = "71000000-0000-4000-8000-000000000001";
  let approved = false;
  const request = () => ({
    id,
    provider: "codex",
    version: approved ? 2 : 1,
    goal: "整理示例目录",
    goal_id: id,
    run_id: id,
    scope: "/example",
    title: "Codex 请求执行命令",
    action: JSON.stringify({ command: "pwd", cwd: "/example" }),
    created: "2026-11-26T06:00:00Z",
    kind: "approval",
    risk: "需审查",
    blocking: 1,
    status: approved ? "approved" : "pending",
    allow_for_run: 1,
  });
  await page.route("**/api/v1/inbox", (r) =>
    r.fulfill({ json: { data: [request()] } }),
  );
  await page.route("**/api/v1/inbox/" + id, (r) =>
    r.fulfill({
      json: {
        data: {
          ...request(),
          audit: approved
            ? [
                {
                  id: 1,
                  actor: "user",
                  action: "approve_run",
                  created: request().created,
                },
              ]
            : [],
        },
      },
    }),
  );
  await page.route("**/api/v1/inbox/" + id + "/decision", (r) => {
    expect(r.request().postDataJSON()).toMatchObject({
      decision: "approve_run",
      version: 1,
    });
    approved = true;
    return r.fulfill({ json: { data: request() } });
  });
  await page.goto("/#inbox/" + id);
  await expect(
    page.getByRole("button", { name: "仅允许这一次" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "允许本轮后续操作" }).click();
  await expect(
    page.getByText("批准本次及本轮后续操作", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "允许本轮后续操作" }),
  ).toHaveCount(0);
});
