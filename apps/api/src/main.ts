import { createServer } from "./server.ts";
const execve = process.execve;
let closing = false;
async function shutdown(restart: boolean) {
  if (closing) return;
  closing = true;
  try {
    await app.close();
    if (restart && execve) {
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
const { app } = await createServer({
  seed: process.env.CONTINUUM_SEED !== "0",
  restart:
    execve && process.platform !== "win32"
      ? () => void shutdown(true)
      : undefined,
});
const url = await app.listen({
  host: "127.0.0.1",
  port: Number(process.env.PORT || 4317),
});
console.log("Continuum " + url);
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => void shutdown(false));
