import { expect, test } from "@playwright/test";

const title =
  "核对离线编辑后的同步结果，确认恢复连接时两台设备上的修改都保留在同一份笔记中";
const summary = "两台测试设备已恢复同步。离线期间新增的段落和标签都已保存。";
const created = "2026-11-26T07:55:00Z";

for (const theme of ["light", "dark"] as const) {
  for (const width of [1280, 375]) {
    test(`长内容与关联操作 · ${theme} · ${width}`, async ({
      page,
      request,
    }, info) => {
      await page.setViewportSize({ width, height: 820 });
      await page.emulateMedia({ colorScheme: theme });
      const goals = (await (await request.get("/api/v1/goals")).json()).data;
      const goal = (
        await (await request.get("/api/v1/goals/" + goals[0].id)).json()
      ).data;
      const goalPath = "**/api/v1/goals/" + goal.id;
      const run = "10000000-0000-4000-8000-000000000003";
      const report = {
        id: "report-1",
        goal: title,
        goal_id: goal.id,
        updated: created,
        summary,
        provider: "codex",
        run_id: run,
        seq: 2,
      };
      const checkWidth = async () =>
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBeLessThanOrEqual(width);
      const capture = async (view: string) => {
        await checkWidth();
        await page.screenshot({ path: info.outputPath(view + ".png") });
      };
      await page.route("**/api/v1/conversation", (r) =>
        r.fulfill({
          json: {
            data: [
              {
                id: goal.id,
                seq: 1,
                role: "assistant",
                kind: "result",
                body: summary,
                created,
                origin: "run:" + run,
                refs: [{ id: goal.id, title }],
              },
            ],
          },
        }),
      );
      await page.route(goalPath, (r) =>
        r.fulfill({
          json: {
            data: {
              ...goal,
              title,
              description: title,
              state: "active",
              provider: "codex",
              usage: { input: 18590, output: 710, total: 19300 },
              approvalGrant: goal.id,
              nativeResults: [],
              workspace: { ...goal.workspace, name: "笔记项目" },
              arrangement: { mode: "work", notify: "always", next_at: null },
            },
          },
        }),
      );
      await page.route(goalPath + "/runs", (r) =>
        r.fulfill({ json: { data: [] } }),
      );
      await page.route(goalPath + "/reports", (r) =>
        r.fulfill({ json: { data: [report] } }),
      );
      await page.route("**/api/v1/briefings/generate", (r) =>
        r.fulfill({
          json: {
            data: {
              id: goal.id,
              sections: { needs: [], next: [], changes: [], insights: [], outcomes: [] },
              count: 2,
              window_end: created,
              reports: [report],
              native: [
                {
                  ...report,
                  id: "native-2",
                  updated: "2026-11-26T06:20:00Z",
                  goal: "发布前检查",
                  summary: "预览环境的检查已完成，可以继续下一项。",
                },
              ],
            },
          },
        }),
      );
      await page.goto("/#chat");
      const sourceToggle = page.getByRole("button", { name: "关联记录" });
      await sourceToggle.focus();
      await page.keyboard.press("Enter");
      const sources = page.locator(".chat-sources:visible");
      const [toolbar, records] = await Promise.all([
        page.locator(".message-links").boundingBox(),
        sources.boundingBox(),
      ]);
      expect(records!.y).toBeGreaterThanOrEqual(toolbar!.y + toolbar!.height);
      expect(Math.abs(records!.x - toolbar!.x)).toBeLessThan(2);
      await expect(
        sources.getByRole("link", { name: "运行 查看依据" }),
      ).toHaveAttribute("href", "#run/" + run);
      await capture("chat");
      await sources.getByRole("link", { name: "委托 " + title }).click();
      await expect(
        page.getByRole("heading", { name: title, exact: true }),
      ).toBeVisible();
      await expect(page.getByText(title, { exact: true })).toHaveCount(1);
      await expect(
        page.getByRole("button", { name: "开始运行" }),
      ).toBeEnabled();
      await expect(
        page.getByRole("button", { name: "调整委托要求" }),
      ).toBeHidden();
      await capture("goal");
      const manage = page.getByRole("button", { name: "管理委托" });
      await manage.focus();
      await page.keyboard.press("Space");
      await expect(
        page.getByRole("button", { name: "调整委托要求" }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "查看原始授权" }),
      ).toHaveAttribute("href", "#inbox/" + goal.id);
      await checkWidth();
      await page.goto("/#today");
      const list = page
        .locator(".record-list")
        .filter({ has: page.getByRole("link", { name: title, exact: true }) });
      await expect(list.locator("article")).toHaveCount(2);
      await expect(list.locator(".panel")).toHaveCount(0);
      await expect(
        list.getByRole("link", { name: "查看依据" }),
      ).toHaveAttribute("href", "#run/" + run);
      await expect(
        list.getByRole("link", { name: "在主对话中继续" }),
      ).toHaveAttribute("href", "#chat/" + goal.id);
      await capture("today");
    });
  }
}
