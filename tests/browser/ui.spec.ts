import { test, expect } from "@playwright/test";
test("工作台流程、主题、移动端、七个验收截图与控制台", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  const shot = (name: string) =>
    page.screenshot({
      path: "docs/screenshots/" + name + ".png",
      fullPage: true,
    });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "今日简报" })).toBeVisible();
  await expect(page.getByText("地图渲染通过验证")).toBeVisible();
  await shot("today");
  await page.getByRole("link", { name: "审阅请求" }).click();
  await page.getByText("核对原始请求与范围", { exact: true }).click();
  await expect(
    page.getByText("demo.preview.publish", { exact: false }),
  ).toBeVisible();
  await shot("inbox-pending");
  await page.getByRole("button", { name: "仅允许这一次" }).click();
  await expect(
    page.getByText("本次请求已关闭。", { exact: false }),
  ).toBeVisible();
  await shot("inbox-completed");
  await page
    .getByRole("link", { name: "开发战棋游戏原型", exact: true })
    .click();
  await page.getByText("原始要求与验收记录", { exact: true }).click();
  await expect(page.getByText("can render map", { exact: true })).toBeVisible();
  await shot("goal");
  await page.getByText("更多工具", { exact: true }).click();
  await page.getByRole("link", { name: "活动记录", exact: true }).click();
  await page.getByText("演示任务已完成", { exact: true }).click();
  await expect(page.getByRole("link", { name: "打开运行详情" })).toBeVisible();
  await shot("activity");
  await page.getByRole("link", { name: "今天", exact: true }).click();
  await expect(
    page.getByText("寻路修复通过回归测试", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "标记已读" }).click();
  await expect(
    page.getByRole("heading", { name: "暂无重要变化" }),
  ).toBeVisible();
  await shot("today-quiet");
  await page.getByRole("link", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "检查连接" }).click();
  await expect(page.getByText("连接不可用", { exact: true })).toBeVisible();
  await shot("disconnected");
  await page.getByRole("link", { name: "我的委托", exact: true }).click();
  await page.getByRole("button", { name: "高级创建" }).click();
  await page.getByLabel("目标名称").fill("浏览器验收");
  await page.getByLabel("预期结果").fill("验证可交互流程");
  await page.getByLabel("验收条件").fill("通过检查");
  const workspace = page.getByLabel("允许使用的项目目录");
  await workspace.selectOption(
    await workspace
      .getByRole("option", { name: /\/demo-project$/ })
      .elementHandle(),
  );
  await page.getByRole("button", { name: "创建目标" }).click();
  await expect(page.getByRole("heading", { name: "浏览器验收" })).toBeVisible();
  await page.getByRole("button", { name: "开始运行" }).click();
  await expect(page.getByRole("button", { name: "中断本轮" })).toBeVisible();
  await page.getByRole("button", { name: "跟进目标" }).click();
  await page.getByLabel("跟进指令", { exact: true }).fill("检查下一项验收条件");
  await page.getByRole("button", { name: "发送指令", exact: true }).click();
  await page.getByRole("button", { name: "指令历史" }).click();
  await expect(page.getByText("检查下一项验收条件")).toBeVisible();
  await page.getByRole("button", { name: "切换明暗主题" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "切换导航" }).click();
  await page.getByRole("link", { name: "今天", exact: true }).click();
  await expect(page.getByRole("heading", { name: "今日简报" })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});
test("实时流断开后从 Last-Event-ID 重放持久化事件", async ({ request }) => {
  const activity = (
    await (await request.get("/api/v1/activity?cursor=0")).json()
  ).data;
  expect(activity.length).toBeGreaterThan(2);
  async function read(cursor: number, header?: string) {
    const controller = new AbortController();
    const res = await fetch(
      "http://127.0.0.1:4389/api/v1/stream?cursor=" + cursor,
      {
        headers: header ? { "Last-Event-ID": header } : {},
        signal: controller.signal,
      },
    );
    const reader = res.body!.getReader();
    let data = "";
    try {
      while (!data.includes("event: change")) {
        const chunk = await reader.read();
        data += new TextDecoder().decode(chunk.value);
      }
    } finally {
      controller.abort();
    }
    return Number(/id: (\d+)/.exec(data)![1]);
  }
  const first = await read(0);
  const second = await read(0, String(first));
  expect(second).toBe(activity.find((e: { seq: number }) => e.seq > first).seq);
});
