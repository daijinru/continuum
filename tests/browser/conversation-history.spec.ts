import { expect, test } from "@playwright/test";

test("长会话只挂载阅读附近的行，向上加载和收到新消息时保留阅读位置", async ({
  page,
}) => {
  await page.setViewportSize({ width: 760, height: 680 });
  const total = 1600;
  let latest = total;
  const make = (seq: number) => ({
    id: "row-" + seq,
    seq,
    created: new Date(1700000000000 + seq * 120000).toISOString(),
    role: "assistant",
    kind: "result",
    refs: [],
    body:
      seq % 7
        ? "记录 " + seq
        : "记录 " + seq + "\n\n" + "正文细节。".repeat(340),
  });
  await page.route(/\/api\/v1\/conversation(?:\?|$)/, (r) => {
    const before = Number(
      new URL(r.request().url()).searchParams.get("before") ?? latest + 1,
    );
    const end = Math.min(before - 1, latest);
    return r.fulfill({
      headers: { "X-Conversation-Version": String(latest) },
      json: {
        data: Array.from({ length: Math.min(end, 80) }, (_, i) =>
          make(Math.max(1, end - 79) + i),
        ),
      },
    });
  });
  await page.route("**/api/v1/conversation/changes?*", (r) => {
    const since = Number(new URL(r.request().url()).searchParams.get("since"));
    return r.fulfill({
      json: {
        data: {
          rows: since < latest ? [make(latest)] : [],
          version: latest,
          more: false,
        },
      },
    });
  });
  const notify = async () => {
    latest++;
    await page.evaluate(
      (v) =>
        window.dispatchEvent(
          new CustomEvent("conversation-changed", { detail: v }),
        ),
      latest,
    );
  };
  const stream = page.locator(".chat-stream");
  const row = (i: number) => page.locator('[data-message-id="row-' + i + '"]');
  const top = async (i: number) =>
    row(i)
      .locator("article")
      .evaluate((e) => e.getBoundingClientRect().top);
  await page.goto("/#chat");
  await expect(row(total)).toBeInViewport();
  await notify();
  await expect(row(latest)).toBeInViewport();
  for (let i = 0; i < 10; i++) {
    const oldest = total - 79 - 80 * i;
    await expect(async () => {
      await page
        .getByRole("button", { name: "查看更早的消息" })
        .scrollIntoViewIfNeeded();
      await expect(row(oldest)).toBeInViewport({ timeout: 500 });
    }).toPass();
    const y = await top(oldest);
    const fetched = page.waitForResponse((r) =>
      r.url().includes("conversation?before=" + oldest),
    );
    await page.getByRole("button", { name: "查看更早的消息" }).click();
    await fetched;
    await expect
      .poll(() => stream.evaluate((e) => e.scrollTop))
      .toBeGreaterThan(1000);
    await expect(row(oldest)).toBeInViewport();
    await expect
      .poll(async () => Math.abs((await top(oldest)) - y))
      .toBeLessThan(5);
    expect(await page.locator(".chat-row").count()).toBeLessThan(50);
  }
  const anchor = total - 79 - 9 * 80;
  const y = await top(anchor);
  const sync = page.waitForResponse((r) =>
    r.url().includes("conversation/changes?"),
  );
  await notify();
  await sync;
  await expect(row(latest)).toHaveCount(0);
  expect(Math.abs((await top(anchor)) - y)).toBeLessThan(5);

  const long = row(anchor - (anchor % 7));
  await long.scrollIntoViewIfNeeded();
  await long.locator("summary").click();
  await expect(long.locator("details")).toHaveAttribute("open", "");
  const offset = await stream.evaluate((e) => e.scrollTop);
  await stream.evaluate((e) => {
    e.scrollTop = e.scrollHeight;
  });
  await expect(long).toHaveCount(0);
  await expect(row(latest)).toBeInViewport();
  await stream.evaluate((e, y) => {
    e.scrollTop = y;
  }, offset);
  await expect(long.locator("details")).toHaveAttribute("open", "");
  expect(await page.locator(".chat-row").count()).toBeLessThan(50);
});

test("窄屏在旧页填写的目录，滚出再回来仍然保留", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 700 });
  const rows = Array.from({ length: 85 }, (_, i) => ({
    id: "m-" + (i + 1),
    seq: i + 1,
    role: "assistant",
    created: "2026-11-26T08:00:00Z",
    kind: i === 1 ? "project" : "message",
    body: "记录 " + i,
    project: "?",
    refs: [],
  }));
  await page.route(/\/api\/v1\/conversation(?:\?|$)/, (r) => {
    const before = Number(
      new URL(r.request().url()).searchParams.get("before") ?? 86,
    );
    return r.fulfill({
      headers: { "X-Conversation-Version": "85" },
      json: { data: rows.filter((row) => row.seq < before).slice(-80) },
    });
  });
  await page.route("**/api/v1/conversation/changes?*", (r) =>
    r.fulfill({ json: { data: { rows: [], version: 85, more: false } } }),
  );
  await page.goto("/#chat");
  const stream = page.locator(".chat-stream");
  await expect(page.locator('[data-message-id="m-85"]')).toBeInViewport();
  await page.getByRole("button", { name: "查看更早的消息" }).click();
  await expect(
    page.getByRole("button", { name: "查看更早的消息" }),
  ).toHaveCount(0);
  await stream.evaluate((e) => {
    e.scrollTop = 0;
  });
  const form = page.locator('[data-message-id="m-2"]');
  await form.locator("select").selectOption("new");
  await form.locator("input[name=name]").fill("测试项目");
  await form.locator("input[name=path]").fill("/example/project");
  await stream.hover();
  await page.mouse.wheel(0, 20000);
  await expect(form).toHaveCount(0);
  await page.mouse.wheel(0, -20000);
  await expect(form.locator("input[name=name]")).toHaveValue("测试项目");
  await expect(form.locator("input[name=path]")).toHaveValue(
    "/example/project",
  );
});
