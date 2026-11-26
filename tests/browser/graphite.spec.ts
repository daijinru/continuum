import { expect, test } from "@playwright/test";

test("石墨灰主对话：系统外观、定向回复、问进度与键盘焦点", async ({ page }) => {
  const id = "20000000-0000-4000-8000-000000000001";
  const refs = [
    { id: "10000000-0000-4000-8000-000000000001", title: "示例关注" },
  ];
  const posts: Record<string, unknown>[] = [];
  await page.route("**/api/v1/conversation", (r) =>
    r.fulfill({
      json: {
        data: [
          {
            id,
            seq: 1,
            role: "assistant",
            kind: "result",
            body: "示例结果",
            created: "2026-11-25T01:02:00Z",
            refs,
          },
        ],
      },
    }),
  );
  await page.route("**/api/v1/conversation/messages", (r) => {
    posts.push(r.request().postDataJSON());
    return r.fulfill({ json: { data: { id } } });
  });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  const field = page.getByRole("textbox", { name: "发到主对话" });
  await page.getByRole("button", { name: "回复这条" }).click();
  await expect(field).toBeFocused();
  await field.fill("只关注离线工具");
  await field.press("Meta+Enter");
  await expect(page.locator(".reply-context")).toHaveCount(0);
  expect(posts[0]).toMatchObject({ replyTo: id, text: "只关注离线工具" });
  await field.fill("未发出的草稿");
  await page.getByRole("button", { name: "问进度" }).click();
  await expect.poll(() => posts.length).toBe(2);
  expect(posts[1]).toMatchObject({ text: "现在都怎么样了？" });
  expect(posts[1]).not.toHaveProperty("replyTo");
  await page.keyboard.press("Meta+k");
  await expect(field).toBeFocused();
  await expect(field).toHaveValue("未发出的草稿");
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(field).toBeInViewport();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(375);
});

test("主输入框不选目录，首次项目授权在对应消息内完成", async ({ page }) => {
  const id = "20000000-0000-4000-8000-000000000002";
  let confirmed = false;
  await page.route("**/api/v1/conversation", (r) =>
    r.fulfill({
      json: {
        data: [
          {
            id,
            seq: 1,
            role: "assistant",
            kind: "project",
            body: "请确认计划室对应的本地项目。",
            created: "2026-11-25T01:02:00Z",
            refs: [],
            project: "计划室",
            resolvedBy: confirmed ? id : null,
          },
        ],
      },
    }),
  );
  await page.route("**/api/v1/conversation/projects/" + id, (r) => {
    expect(r.request().postDataJSON()).toEqual({
      kind: "authorize",
      path: "/example/planroom",
      name: "计划室",
    });
    confirmed = true;
    return r.fulfill({ json: { data: { id } } });
  });
  await page.goto("/");
  await expect(page.locator(".main-composer")).not.toContainText("工作目录");
  await page.getByLabel("项目目录的绝对路径").fill("/example/planroom");
  await page.getByRole("button", { name: "授权并继续" }).click();
  await expect(page.getByLabel("项目目录的绝对路径")).toHaveCount(0);
  expect(confirmed).toBe(true);
});

test("在目录提醒中为当前委托确认新位置", async ({ page }) => {
  const id = "20000000-0000-4000-8000-000000000003";
  let confirmed = false;
  await page.route("**/api/v1/conversation", (route) =>
    route.fulfill({
      json: {
        data: [
          {
            id,
            seq: 1,
            role: "assistant",
            kind: "directory",
            created: "2026-11-25T01:02:00Z",
            refs: [{ id, title: "更新说明" }],
            body: "更新说明还没开始，项目文件夹找不到。",
            directoryPath: "/example/old",
            canRecover: 1,
            resolvedBy: confirmed ? id : null,
          },
        ],
      },
    }),
  );
  await page.route("**/api/v1/conversation/directories/" + id, (route) => {
    const payload = route.request().postDataJSON();
    if (!payload.path)
      return route.fulfill({
        status: 422,
        json: { error: "项目文件夹找不到或无法访问" },
      });
    expect(payload).toEqual({ path: "/example/new" });
    confirmed = true;
    return route.fulfill({ json: { data: { id } } });
  });
  await page.goto("/");
  await expect(page.getByText("/example/old")).toBeVisible();
  await page.getByRole("button", { name: "原目录已恢复，继续" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "项目文件夹找不到或无法访问",
  );
  await page.getByRole("button", { name: "更换这项委托的目录" }).click();
  await page.getByLabel("项目目录的绝对路径").fill("/example/new");
  await page.getByRole("button", { name: "确认新位置并继续" }).click();
  await expect(page.getByText("目录已确认")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "确认新位置并继续" }),
  ).toHaveCount(0);
});
