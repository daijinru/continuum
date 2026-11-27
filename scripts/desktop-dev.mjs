// This process outlives the editable Electron entry point, including bad saves.
import { execFileSync, fork, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, watch } from "node:fs";
import { cp, glob, mkdir, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "continuum-dev-web-"));
const staging = join(scratch, "build");
const site = join(scratch, "site");
let desktop, builder, timer;
let busy = false;
let stopping = false;
let ready = false;
let canControl = false;
let buildNeeded = true;
let restartNeeded = false;
let restartSent = false;
let launcherChanged = false;
let replaceLauncher = false;
let port = process.env.PORT || "0";
let hidden = process.env.CONTINUUM_DEV_HIDDEN === "1";
let hash = process.env.CONTINUUM_DEV_HASH || "";
let updated = process.env.CONTINUUM_DEV_UPDATED === "1";
let lastAssets = new Set();

function schedule(delay = 180) {
  clearTimeout(timer);
  if (!stopping) timer = setTimeout(update, delay);
}

const watcher = watch(root, { recursive: true }, (_event, file) => {
  if (!file) return;
  if (file === "scripts/desktop-dev.mjs") {
    launcherChanged = true;
    return schedule();
  }
  const dependencyUpdate = [
    "node_modules/.modules.yaml",
    "node_modules/.pnpm/lock.yaml",
  ].includes(file);
  if (
    !dependencyUpdate &&
    /(^|\/)(node_modules|dist|\.git|\.local)(\/|$)/.test(file)
  )
    return;
  const config =
    dependencyUpdate ||
    /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig.*\.json)$/.test(
      file,
    );
  const shared = file.startsWith("packages/");
  const web = config || shared || file.startsWith("apps/web/");
  const runtime =
    config ||
    shared ||
    /^apps\/(api|worker|desktop)\//.test(file) ||
    file.startsWith("migrations/") ||
    file === "scripts/desktop-dev-entry.mjs";
  if (!web && !runtime) return;
  buildNeeded ||= web;
  restartNeeded ||= runtime;
  schedule();
});

function launch() {
  const entry = join(root, "scripts/desktop-dev-entry.mjs");
  if (
    spawnSync(process.execPath, ["--check", entry], { stdio: "inherit" })
      .status !== 0
  )
    return;
  console.log("[desktop:dev] 启动开发客户端");
  const proc = fork(entry, process.argv.slice(2), {
    // A pnpm install can point the Electron dependency at a new version.
    execPath: execFileSync(process.execPath, ["-p", "require('electron')"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    execArgv: [],
    cwd: root,
    env: {
      ...process.env,
      PORT: port,
      CONTINUUM_DEV_WEB_DIST: site,
      CONTINUUM_DEV_HIDDEN: hidden ? "1" : "0",
      CONTINUUM_DEV_HASH: hash,
      CONTINUUM_DEV_UPDATED: updated ? "1" : "0",
    },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  desktop = proc;
  let relaunch = false;
  proc.on("message", (msg) => {
    if (msg.type === "dev-listening") {
      canControl = true;
      if (restartNeeded) schedule();
    } else if (msg.type === "dev-ready") {
      port = msg.port;
    } else if (msg.type === "dev-relaunch") {
      relaunch = true;
      updated = true;
      hidden = msg.hidden;
      hash = msg.hash;
    }
  });
  proc.on("error", (err) => console.error(err.message));
  proc.once("close", (code, signal) => {
    desktop = undefined;
    canControl = false;
    restartSent = false;
    if (stopping || (!relaunch && code === 0)) return void shutdown();
    if (relaunch || restartNeeded) schedule(0);
    else
      console.error(
        "[desktop:dev] 客户端启动失败，保存修复后会重试。",
        signal || code,
      );
  });
}

async function buildWeb() {
  const vite = join(root, "node_modules/vite/bin/vite.js");
  const proc = spawn(
    process.execPath,
    [
      vite,
      "build",
      "apps/web",
      "--mode",
      "desktop-dev",
      "--outDir",
      staging,
      "--emptyOutDir",
    ],
    {
      cwd: root,
      stdio: "inherit",
    },
  );
  builder = proc;
  const success = await new Promise((resolve, reject) => {
    proc.once("error", reject);
    proc.once("close", (code) => resolve(code === 0));
  });
  builder = undefined;
  if (!success || stopping) return false;
  // Publish hashed assets first. Open windows can still request an older chunk.
  await mkdir(site, { recursive: true });
  const entry = join(staging, "index.html");
  await cp(staging, site, {
    recursive: true,
    filter: (path) => path !== entry,
  });
  const topLevel = await readdir(staging);
  await rename(entry, join(site, "index.html"));
  for (const name of await readdir(site)) {
    if (name !== "assets" && !topLevel.includes(name))
      await rm(join(site, name), { recursive: true });
  }
  const assets = new Set(
    await Array.fromAsync(glob("assets/*", { cwd: staging })),
  );
  for await (const name of glob("assets/*", { cwd: site })) {
    if (!assets.has(name) && !lastAssets.has(name))
      await rm(join(site, name), { recursive: true });
  }
  lastAssets = assets;
  return true;
}

async function update() {
  if (busy || stopping) return;
  busy = true;
  try {
    if (launcherChanged) {
      launcherChanged = false;
      replaceLauncher =
        spawnSync(process.execPath, ["--check", import.meta.filename], {
          stdio: "inherit",
        }).status === 0;
      restartNeeded ||= replaceLauncher;
    }
    if (replaceLauncher && !desktop) {
      await rm(scratch, { recursive: true, force: true });
      if (stopping) return;
      process.execve(
        process.execPath,
        [process.execPath, ...process.argv.slice(1)],
        {
          ...process.env,
          PORT: port,
          CONTINUUM_DEV_HIDDEN: hidden ? "1" : "0",
          CONTINUUM_DEV_HASH: hash,
          CONTINUUM_DEV_UPDATED: updated ? "1" : "0",
        },
      );
    }
    let refreshed = false;
    if (buildNeeded) {
      buildNeeded = false;
      refreshed = await buildWeb();
      ready ||= refreshed;
    }
    if (!ready || stopping) return;
    if (!desktop) {
      restartNeeded = false;
      launch();
    } else if (
      restartNeeded &&
      !restartSent &&
      canControl &&
      desktop.connected
    ) {
      restartNeeded = false;
      restartSent = true;
      desktop.send({ type: "dev-restart" });
    } else if (refreshed && desktop.connected) {
      desktop.send({ type: "dev-refresh" });
    }
  } catch (err) {
    if (!stopping) console.error("[desktop:dev]", err.message);
  } finally {
    busy = false;
    if (stopping) await shutdown();
    else if (
      launcherChanged ||
      buildNeeded ||
      (restartNeeded && canControl && !restartSent)
    )
      schedule();
  }
}

async function shutdown() {
  if (!stopping) {
    stopping = true;
    watcher.close();
    clearTimeout(timer);
    builder?.kill();
    if (canControl && desktop?.connected) desktop.send({ type: "dev-stop" });
    else desktop?.kill("SIGTERM");
  }
  if (!desktop && !builder && !busy)
    await rm(scratch, { recursive: true, force: true });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
await update();
