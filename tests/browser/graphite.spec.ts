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
