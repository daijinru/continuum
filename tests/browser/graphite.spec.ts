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

test("慢响应时立即显示发送的消息，可继续输入，失败重试保留原回复关联", async ({
  page,
}) => {
  const reply = "21000000-0000-4000-8000-000000000001";
  const feed = [
    {
      id: reply,
      seq: 1,
      created: new Date().toISOString(),
      role: "assistant",
      kind: "result",
      body: "整理已完成",
      refs: [{ id: reply, title: "资料整理" }],
    },
  ];
  const posts: { key: string; text: string; replyTo?: string }[] = [];
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/conversation", (r) =>
    r.fulfill({ json: { data: feed } }),
  );
  await page.route("**/api/v1/conversation/messages", async (r) => {
    const payload = r.request().postDataJSON();
    posts.push(payload);
    if (posts.length === 1) {
      await wait;
      await r.abort("failed");
    } else {
      const saved = {
        id: payload.key,
        seq: 2,
        created: new Date().toISOString(),
        role: "user",
        kind: "message",
        body: payload.text,
        refs: [],
      };
      feed.push(saved);
      await r.fulfill({ json: { data: saved } });
    }
  });
  await page.goto("/");
  await page.getByRole("button", { name: "回复这条" }).click();
  const field = page.getByRole("textbox", { name: "发到主对话" });
  await field.fill("再整理一次");
  await field.press("Meta+Enter");
  const bubble = page.locator("article.user").filter({ hasText: "再整理一次" });
  await expect(bubble).toBeVisible();
  await expect(bubble).toContainText("发送中");
  await expect(field).toHaveValue("");
  await expect(page.locator(".reply-context")).toHaveCount(0);
  await field.fill("下一条草稿");
  release();
  await expect(bubble.getByRole("button", { name: "重试发送" })).toBeVisible();
  await page.reload();
  await expect(field).toHaveValue("下一条草稿");
  await bubble.getByRole("button", { name: "重试发送" }).click();
  await expect.poll(() => posts.length).toBe(2);
  expect(posts[1]).toEqual(posts[0]);
  expect(posts[1].replyTo).toBe(reply);
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem("main-outbox")))
    .toBeNull();
  await expect(bubble).toHaveCount(1);
  await expect(bubble.getByRole("button", { name: "重试发送" })).toHaveCount(0);
  await expect(field).toHaveValue("下一条草稿");
});

test("连续操作审批默认仅占一行，展开后可打开每个请求", async ({ page }) => {
  const goal = "21000000-0000-4000-8000-000000000002",
    ids = ["first", "second"];
  const base = {
    role: "assistant",
    kind: "question",
    created: new Date().toISOString(),
    refs: [{ id: goal, title: "整理日志" }],
  };
  await page.route("**/api/v1/conversation", (r) =>
    r.fulfill({
      json: {
        data: [
          {
            ...base,
            id: goal,
            seq: 2,
            body: "操作需要授权",
            approvalGoal: goal,
            approvalTotal: 2,
            approvalPending: 1,
            nextApproval: "second",
          },
          {
            ...base,
            id: "message",
            seq: 3,
            body: "请选择保存格式",
            kind: "question",
            origin: "inbox:input",
          },
        ],
      },
    }),
  );
  let loads = 0;
  await page.route("**/api/v1/conversation/approvals/" + goal, (r) => {
    loads++;
    return r.fulfill({
      json: {
        data: ids.map((id, i) => ({
          id,
          seq: i + 1,
          created: base.created,
          title: "核对操作 " + id,
          status: i ? "pending" : "approved",
        })),
      },
    });
  });
  await page.goto("/");
  const group = page.locator(".chat-approvals");
  await expect(group).toHaveCount(1);
  await expect(group).toContainText("1 条待处理");
  await expect(group.getByRole("link", { name: "去处理" })).toHaveAttribute(
    "href",
    "#inbox/second",
  );
  await expect(page.getByText("请选择保存格式")).toBeVisible();
  expect(loads).toBe(0);
  await group.locator("summary").click();
  await expect(
    group.getByRole("link", { name: "核对操作 first" }),
  ).toHaveAttribute("href", "#inbox/first");
  await expect(group.getByText("已批准")).toBeVisible();
  await group.locator("summary").click();
  await expect(group.getByText("已批准")).toBeHidden();
});

test("连续发送立即上屏，按发送顺序提交，轮询先收到确认也只显示一条", async ({
  page,
}) => {
  type Receipt = {
    id: string;
    seq: number;
    body: string;
    created: string;
    role: string;
    kind: string;
    refs: unknown[];
  };
  const history: Receipt[] = [];
  let finishFirst!: () => void;
  const wait = new Promise<void>((resolve) => {
    finishFirst = resolve;
  });
  await page.route("**/api/v1/conversation", (route) =>
    route.fulfill({ json: { data: history } }),
  );
  await page.route("**/api/v1/conversation/messages", async (route) => {
    const request = route.request().postDataJSON();
    const message = {
      id: request.key,
      seq: history.length + 1,
      body: request.text,
      created: new Date().toISOString(),
      role: "user",
      kind: "message",
      refs: [],
    };
    history.push(message);
    if (message.seq === 1) await wait;
    await route.fulfill({ json: { data: message } });
  });
  await page.goto("/");
  const field = page.getByRole("textbox", { name: "发到主对话" });
  await field.fill("第一条");
  await field.press("Meta+Enter");
  await field.fill("第二条");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const bubbles = page.locator("article.user");
  await expect(bubbles).toHaveCount(2);
  await expect(bubbles.last()).toContainText("等待发送");
  await expect.poll(() => history.map((row) => row.body)).toEqual(["第一条"]);
  await expect(bubbles.first().getByRole("status")).toHaveCount(0);
  finishFirst();
  await expect
    .poll(() => history.map((row) => row.body))
    .toEqual(["第一条", "第二条"]);
  await expect(bubbles).toHaveCount(2);
  await expect(bubbles.first()).toContainText("第一条");
  await expect(bubbles.last()).toContainText("第二条");
});
