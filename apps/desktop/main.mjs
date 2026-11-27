import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  shell,
  Tray,
} from "electron";
import { fork } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const development = !app.isPackaged;
const supervised =
  development && !!process.send && !!process.env.CONTINUUM_DEV_WEB_DIST;
if (development) {
  app.setName("Continuum Dev");
  if (!app.commandLine.hasSwitch("user-data-dir")) {
    const devProfile = join(app.getPath("appData"), app.getName());
    mkdirSync(devProfile, { recursive: true, mode: 0o700 });
    app.setPath("userData", devProfile);
  }
}
const profile = app.getPath("userData");
const root = development
  ? join(import.meta.dirname, "../..")
  : join(process.resourcesPath, "workbench");
let child, win, tray, address, retry;
let wantWindow = true,
  quitting = false,
  checkingQuit = false;
let crashes = [];
let serviceEnv;
let restartRequested = false;
let confirmingUpdate = false;
let forcingUpdate = false;
let justUpdated = process.env.CONTINUUM_DEV_UPDATED === "1";

function environment() {
  const path = join(profile, "workbench.json");
  const config = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  const data =
    process.env.CONTINUUM_DATA ?? config.dataDirectory ?? join(profile, "data");
  if (
    !isAbsolute(data) ||
    (config.codexBinDirectory && !isAbsolute(config.codexBinDirectory))
  )
    throw Error("工作台数据目录和 Codex 工具目录需要绝对路径。");
  return {
    ...process.env,
    PORT: process.env.PORT || (development ? "0" : "4317"),
    CONTINUUM_DATA: data,
    CONTINUUM_SEED: process.env.CONTINUUM_SEED ?? "0",
    PATH: [
      config.codexBinDirectory,
      development ? undefined : join(root, "bin"),
      process.env.PATH,
      "/usr/local/bin",
      "/opt/homebrew/bin",
    ]
      .filter(Boolean)
      .join(":"),
  };
}

function showWindow() {
  wantWindow = true;
  if (!address || quitting) return;
  if (!win) {
    win = new BrowserWindow({
      title: "Continuum",
      width: 1180,
      height: 820,
      webPreferences: {
        preload: supervised
          ? join(import.meta.dirname, "dev-preload.cjs")
          : undefined,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    win.webContents.on("will-navigate", (event, url) => {
      if (new URL(url).origin !== address) event.preventDefault();
    });
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (["http:", "https:"].includes(new URL(url).protocol))
        void shell.openExternal(url);
      return { action: "deny" };
    });
    win.on("closed", () => {
      win = undefined;
      wantWindow = false;
    });
    const initialHash = supervised ? process.env.CONTINUUM_DEV_HASH || "" : "";
    if (supervised) delete process.env.CONTINUUM_DEV_HASH;
    void win
      .loadURL(address + (initialHash.startsWith("#") ? initialHash : ""))
      .catch(console.error);
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function startService() {
  if (quitting || child) return;
  const entry = development ? "apps/api/src/main.ts" : "apps/api/src/main.mjs";
  const proc = fork(join(root, entry), [], {
    execPath: development
      ? process.env.npm_node_execpath || "node"
      : join(root, "bin/node"),
    execArgv: [],
    // A confirmed update may have to stop this service and its remaining tools.
    detached: supervised && process.platform === "darwin",
    cwd: root,
    env: serviceEnv,
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  child = proc;
  proc.on("error", (err) => console.error("服务进程错误", err.message));
  proc.on("message", (message) => {
    if (quitting || typeof message?.ready !== "string") return;
    const url = new URL(message.ready);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") return;
    address = url.origin;
    if (supervised && process.connected) {
      serviceEnv.PORT = url.port;
      process.send({ type: "dev-ready", port: url.port });
      if (restartRequested) {
        proc.send("dev-stop-when-idle");
      }
    }
    if (wantWindow) showWindow();
  });
  proc.once("close", (code) => {
    child = undefined;
    if (restartRequested && !quitting) return relaunchDevelopment();
    address = undefined;
    const reopen = wantWindow;
    win?.destroy();
    wantWindow = reopen;
    if (quitting) return app.quit();
    crashes = crashes.filter((t) => Date.now() - t < 60000);
    if (code !== 75) crashes.push(Date.now());
    if (crashes.length >= 3 && supervised) {
      console.error("工作台服务未能启动，等待下一次保存。");
      return;
    }
    if (crashes.length >= 3) {
      dialog.showErrorBox(
        "工作台服务未能启动",
        "请检查端口、数据目录和旧工作台是否仍在运行，再重新打开 Continuum。",
      );
      quitting = true;
      app.quit();
    } else {
      retry = setTimeout(startService, code === 75 ? 0 : 750);
    }
  });
}

function stopWorkbench() {
  quitting = true;
  clearTimeout(retry);
  if (child) child.kill("SIGTERM");
  else app.quit();
}

function relaunchDevelopment() {
  if (!process.connected) return stopWorkbench();
  process.send(
    {
      type: "dev-relaunch",
      hidden: !wantWindow,
      hash: win ? new URL(win.webContents.getURL() || "about:blank").hash : "",
    },
    stopWorkbench,
  );
}

function isWorkbenchFrame(event) {
  const frame = event.senderFrame;
  return (
    !!win &&
    event.sender === win.webContents &&
    !!frame &&
    frame === win.webContents.mainFrame &&
    URL.canParse(frame.url) &&
    new URL(frame.url).origin === address
  );
}

async function confirmImmediateUpdate(event) {
  const proc = child;
  if (
    !isWorkbenchFrame(event) ||
    !restartRequested ||
    !proc ||
    quitting ||
    confirmingUpdate ||
    forcingUpdate
  )
    return;
  confirmingUpdate = true;
  try {
    const { response } = await dialog.showMessageBox(win, {
      type: "warning",
      message: "立即重启更新？",
      detail:
        "立即重启会中断正在执行的委托。选择「继续等待」，委托结束后会自动更新。",
      buttons: ["继续等待", "中断委托并重启"],
      defaultId: 0,
      cancelId: 0,
    });
    if (
      response !== 1 ||
      child !== proc ||
      proc.exitCode !== null ||
      proc.signalCode !== null ||
      quitting ||
      !isWorkbenchFrame(event)
    )
      return;
    forcingUpdate = true;
    win.webContents.send("dev-update:state", "restarting");
    // Give adapters time to record an interruption. Bound the wait if an
    // executor, source check or model call is stuck during shutdown.
    const terminate = () => {
      try {
        if (process.platform === "darwin") process.kill(-proc.pid, "SIGKILL");
        else proc.kill("SIGKILL");
      } catch (err) {
        if (err.code !== "ESRCH")
          console.error("开发服务未能停止", err.message);
      }
    };
    const deadline = setTimeout(terminate, 2000);
    proc.once("exit", () => {
      clearTimeout(deadline);
      if (process.platform === "darwin") terminate();
    });
    if (proc.connected) proc.send("dev-interrupt-and-stop");
  } finally {
    confirmingUpdate = false;
  }
}

async function quitWorkbench() {
  if (checkingQuit) return;
  checkingQuit = true;
  try {
    if (address) {
      let warning;
      try {
        const res = await fetch(address + "/api/v1/system/monitor", {
          signal: AbortSignal.timeout(4000),
        });
        const { data } = await res.json();
        if (data.tasks.some((task) => task.runId || task.state === "watching"))
          warning = "有委托正在执行。现在退出可能会中断这些工作。";
      } catch {
        warning = "暂时无法确认委托状态。退出将停止本机服务。";
      }
      if (
        warning &&
        (
          await dialog.showMessageBox({
            type: "warning",
            message: warning,
            buttons: ["继续运行", "完全退出"],
            cancelId: 0,
            defaultId: 0,
          })
        ).response !== 1
      )
        return;
    }
    stopWorkbench();
  } finally {
    checkingQuit = false;
  }
}

function menu() {
  const login = app.getLoginItemSettings();
  return [
    { label: "打开工作台", click: showWindow },
    {
      label: "登录时启动 Continuum",
      type: "checkbox",
      enabled: !development,
      checked: login.openAtLogin,
      click(item) {
        app.setLoginItemSettings({ openAtLogin: item.checked });
        const status = app.getLoginItemSettings();
        if (
          status.openAtLogin !== item.checked ||
          status.status === "requires-approval"
        )
          void dialog.showMessageBox({
            message: "请在系统设置的登录项中确认 Continuum 的启动权限。",
          });
        updateMenus();
      },
    },
    { type: "separator" },
    { role: "quit", label: "完全退出 Continuum" },
  ];
}
function updateMenus() {
  tray.setContextMenu(Menu.buildFromTemplate(menu()));
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: "Continuum", submenu: menu() },
      { role: "editMenu" },
      { role: "windowMenu" },
    ]),
  );
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("window-all-closed", () => {
    /* Schedules continue while the tray is open. */
  });
  app.on("before-quit", (event) => {
    if (!quitting || child) {
      event.preventDefault();
      if (!quitting) void quitWorkbench();
    }
  });
  app.on("second-instance", showWindow);
  app
    .whenReady()
    .then(() => {
      if (development)
        app.dock?.setIcon(join(import.meta.dirname, "assets/continuum.png"));
      wantWindow =
        !(supervised && process.env.CONTINUUM_DEV_HIDDEN === "1") &&
        !app.getLoginItemSettings().wasOpenedAtLogin;
      if (supervised) {
        ipcMain.on("dev-update:subscribe", (event) => {
          if (!isWorkbenchFrame(event)) return;
          if (restartRequested)
            event.reply(
              "dev-update:state",
              forcingUpdate ? "restarting" : "pending",
            );
          else if (justUpdated) event.reply("dev-update:state", "updated");
          justUpdated = false;
        });
        ipcMain.handle("dev-update:request", confirmImmediateUpdate);
        process.on("message", (msg) => {
          if (msg.type === "dev-refresh") win?.webContents.reload();
          if (msg.type === "dev-restart" && !quitting && !restartRequested) {
            restartRequested = true;
            win?.webContents.send("dev-update:state", "pending");
            if (!child) relaunchDevelopment();
            else if (address && child.connected)
              child.send("dev-stop-when-idle");
          }
          if (msg.type === "dev-stop") stopWorkbench();
        });
        process.once("disconnect", stopWorkbench);
        if (process.connected) process.send({ type: "dev-listening" });
        else return stopWorkbench();
      }
      app.on("activate", showWindow);
      tray = new Tray(nativeImage.createEmpty());
      tray.setTitle("Continuum");
      tray.setToolTip("Continuum 工作台");
      updateMenus();
      serviceEnv = environment();
      startService();
    })
    .catch((err) => {
      if (supervised) {
        console.error("Continuum 开发客户端启动失败", err);
        return app.exit(1);
      }
      dialog.showErrorBox("Continuum 启动失败", err.message);
      quitting = true;
      app.quit();
    });
}
