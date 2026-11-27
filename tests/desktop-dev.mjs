import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  appendFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const temp = await mkdtemp(join(tmpdir(), "continuum-dev-test-"));
const root = join(temp, "source");
const path = (name) => join(root, name);
let launcher;
let log = "";
async function until(check, label) {
  const deadline = Date.now() + 25000;
  do {
    const result = await check();
    if (result) return result;
    if (launcher.exitCode !== null) break;
    await delay(100);
  } while (Date.now() < deadline);
  throw Error("等待超时：" + label);
}

try {
  await mkdir(path("scripts"), { recursive: true });
  for (const name of [
    "apps",
    "packages",
    "migrations",
    "package.json",
    "tsconfig.json",
    "scripts/desktop-dev.mjs",
    "scripts/desktop-dev-entry.mjs",
  ]) {
    await cp(resolve(name), path(name), {
      recursive: true,
      filter: (file) => !["dist", "node_modules"].includes(basename(file)),
    });
  }
  for (const name of [
    "node_modules",
    "apps/api/node_modules",
    "apps/web/node_modules",
  ]) {
    await symlink(resolve(name), path(name), "dir");
  }

  // Observe the real window and invoke the same close and quit actions as the menus.
  await appendFile(
    path("scripts/desktop-dev-entry.mjs"),
    `
    import { BrowserWindow } from "electron";
    import { existsSync, readFileSync, unlinkSync } from "node:fs";
    app.on("web-contents-created", (_event, contents) => {
      contents.on("did-finish-load", () => console.log("TEST page", contents.getTitle(), contents.getURL()));
    });
    setInterval(async () => {
      const control = process.env.TEST_CONTROL;
      if (!existsSync(control)) return;
      const action = readFileSync(control, "utf8");
      unlinkSync(control);
      const [win] = BrowserWindow.getAllWindows();
      if (action === "navigate") {
        await win.webContents.executeJavaScript('document.querySelector("textarea").focus()');
        await win.webContents.insertText("开发会话草稿");
        await win.webContents.executeJavaScript("location.hash = 'today'");
      }
      if (action === "check-draft") {
        console.log("TEST draft", await win.webContents.executeJavaScript("localStorage.getItem('main-draft')"));
      }
      if (action === "close") win.close();
      if (action === "quit") { console.log("TEST windows", BrowserWindow.getAllWindows().length); app.quit(); }
    }, 100).unref();
  `,
  );
  const control = join(temp, "control");
  const command = async (action) => {
    await writeFile(control + ".tmp", action);
    await rename(control + ".tmp", control);
  };
  launcher = spawn(
    process.execPath,
    ["scripts/desktop-dev.mjs", "--user-data-dir=" + join(temp, "profile")],
    {
      cwd: root,
      env: {
        ...process.env,
        PORT: "0",
        CONTINUUM_SEED: "1",
        CONTINUUM_DATA: join(temp, "data"),
        TEST_CONTROL: control,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const closed = once(launcher, "close");
  for (const stream of [launcher.stdout, launcher.stderr])
    stream.on("data", (chunk) => {
      log += chunk;
    });
  const logged = (value) => until(() => log.includes(value), value);
  const url = await until(
    () => /Continuum (http:\/\/127\.0\.0\.1:\d+)/.exec(log)?.[1],
    "本机服务就绪",
  );
  await logged("TEST page Continuum");
  const api = async (route, options) => {
    const res = await fetch(url + "/api/v1/" + route, options);
    assert.equal(res.status, 200, route);
    return (await res.json()).data;
  };
  const { instance } = await api("health");
  const web = path("apps/web/index.html");
  const html = await readFile(web, "utf8");
  await writeFile(
    web,
    html.replace("/src/main.tsx", "/missing-test-entry.tsx"),
  );
  await logged("missing-test-entry.tsx");
  assert.ok((await (await fetch(url)).text()).includes("<title>Continuum"));
  await command("navigate");
  await writeFile(
    web,
    html.replace(/<title>.*?<\/title>/, "<title>updated</title>"),
  );
  await logged("TEST page updated " + url + "/#today");
  assert.equal((await api("health")).instance, instance);
  console.log(
    "前端构建失败保留旧页面，修复后窗口自动刷新，服务实例和页面位置一致。",
  );

  const [approval] = await api("inbox?status=pending");
  const main = path("apps/api/src/main.ts");
  await appendFile(main, '\nconsole.log("TEST backend updated");\n');
  await logged("等待当前委托结束");
  assert.equal((await api("health")).instance, instance);
  await appendFile(main, '\nconsole.log("TEST latest save");\n');
  const { token } = await api("session");
  await api("inbox/" + approval.id + "/decision", {
    method: "POST",
    headers: { "content-type": "application/json", "x-continuum-token": token },
    body: JSON.stringify({
      decision: "approve",
      version: approval.version,
      key: crypto.randomUUID(),
    }),
  });
  await logged("TEST latest save");
  assert.notEqual((await api("health")).instance, instance);
  assert.equal((await api("runs/" + approval.run_id)).status, "succeeded");
  await until(
    () => log.split("TEST page updated " + url + "/#today").length >= 3,
    "重启后回到原页面",
  );
  console.log("后台等委托完成再更新，同一端口和数据目录可读回执行结果。");

  await command("check-draft");
  await logged("TEST draft 开发会话草稿");
  await command("close");
  await until(
    async () => (await readFile(control).catch(() => null)) === null,
    "关窗",
  );
  const entry = path("apps/desktop/main.mjs");
  const source = await readFile(entry, "utf8");
  await writeFile(entry, source + "\nconst = ;");
  await logged("客户端启动失败");
  await writeFile(entry, source + '\nconsole.log("TEST desktop repaired");');
  await logged("TEST desktop repaired");
  await until(
    async () =>
      fetch(url + "/api/v1/health").then(
        (r) => r.ok,
        () => false,
      ),
    "后台服务恢复",
  );
  const beforeLauncherEdit = (await api("health")).instance;
  await appendFile(
    path("scripts/desktop-dev.mjs"),
    '\nconsole.log("TEST new launcher");',
  );
  await logged("TEST new launcher");
  await until(async () => {
    try {
      return (await api("health")).instance !== beforeLauncherEdit;
    } catch {
      return false;
    }
  }, "开发启动器自身更新后恢复服务");
  await command("quit");
  assert.deepEqual(
    await Promise.race([closed, delay(10000, ["timeout"], { ref: false })]),
    [0, null],
  );
  assert.ok(log.includes("TEST windows 0"));
  await assert.rejects(fetch(url + "/api/v1/health"));
  console.log(
    "Electron 代码出错并修复后自动恢复，窗口保持关闭，完全退出释放服务和启动器。",
  );
} catch (err) {
  console.error(log);
  throw err;
} finally {
  if (launcher && launcher.exitCode === null && !launcher.signalCode) {
    const stopped = once(launcher, "close");
    launcher.kill("SIGTERM");
    await stopped;
  }
  await rm(temp, { recursive: true, force: true });
}
