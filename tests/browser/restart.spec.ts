import { expect, test } from "@playwright/test";

test("设置可取消或实际重启工作台，新实例恢复同一数据库及会话", async ({
  page,
  request,
}) => {
  const base = "/api/v1";
  const read = async (path: string) =>
    (await (await request.get(base + path)).json()).data;
  const before = await read("/health");
  const oldToken = (await read("/session")).token;
  const goals = (await read("/goals")).map((g: { id: string }) => g.id).sort();
  await page.goto("/#settings");
  const restart = page.getByRole("button", { name: "重启服务", exact: true });
  await restart.click();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  expect((await read("/health")).instance).toBe(before.instance);
  await restart.click();
  await page.getByRole("button", { name: "确认重启" }).click();
  await expect(page.getByText("本地服务已重启并就绪")).toBeVisible({
    timeout: 25_000,
  });
  const after = await read("/health");
  expect(after.ready).toBe(true);
  expect(after.instance).not.toBe(before.instance);
  expect(
    (await read("/goals")).map((g: { id: string }) => g.id).sort(),
  ).toEqual(goals);
  const post = (instance: string, token: string) =>
    request.post(base + "/system/restart", {
      headers: { "x-continuum-token": token },
      data: { instance },
    });
  expect((await post(after.instance, oldToken)).status()).toBe(403);
  expect(
    (await post(before.instance, (await read("/session")).token)).status(),
  ).toBe(409);
  expect((await read("/health")).instance).toBe(after.instance);
});
