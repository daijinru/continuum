import { createServer } from "./server.ts";
const execve = process.execve;
let closing = false;
async function shutdown(restart: boolean, interruptRuns = false) {
  if (closing) return;
  closing = true;
  try {
    if (interruptRuns) {
      const runs = db.all(
        "SELECT id,provider FROM agent_runs WHERE finished IS NULL",
      );
      await Promise.allSettled([
        worker.stop(),
        agenda.stop(),
        ...runs.map((run) => s.adapters[run.provider].interrupt(run.id)),
      ]);
    }
    await app.close();
    if (process.send) {
      // The desktop parent owns restarts and waits for the old database owner.
      process.exitCode = restart ? 75 : 0;
      if (process.connected) process.disconnect();
    } else if (restart && execve) {
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          (pair): pair is [string, string] => typeof pair[1] === "string",
        ),
      );
      execve(
        process.execPath,
        [process.execPath, ...process.execArgv, ...process.argv.slice(1)],
        env,
      );
    }
  } catch (err) {
    console.error(
      "工作台关闭或重启失败",
      err instanceof Error ? err.name : "error",
    );
    process.exitCode = 1;
  }
}
const devWebDist = process.send
  ? process.env.CONTINUUM_DEV_WEB_DIST
  : undefined;
const { app, db, agenda, worker, s } = await createServer({
  webDist: devWebDist,
  seed: process.env.CONTINUUM_SEED !== "0",
  restart:
    process.send || (execve && process.platform !== "win32")
      ? () => void shutdown(true)
      : undefined,
});
const url = await app.listen({
  host: "127.0.0.1",
  port: Number(process.env.PORT || 4317),
});
console.log("Continuum " + url);
if (process.send) {
  if (devWebDist) {
    const stopWhenIdle = (waiting = false) => {
      if (closing) return;
      if (
        agenda.active.size ||
        db.one("SELECT 1 FROM agent_runs WHERE finished IS NULL LIMIT 1")
      ) {
        if (!waiting)
          console.log("[desktop:dev] 等待当前委托结束后更新客户端。");
        setTimeout(stopWhenIdle, 2000, true).unref();
      } else void shutdown(false);
    };
    process.on("message", (msg) => {
      if (msg === "dev-stop-when-idle") stopWhenIdle();
      if (msg === "dev-interrupt-and-stop") void shutdown(false, true);
    });
  }
  process.once("disconnect", () => void shutdown(false));
  if (process.connected) process.send({ ready: url });
  else void shutdown(false);
}
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => void shutdown(false));
