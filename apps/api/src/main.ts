import { createServer } from "./server.ts";
const { app } = await createServer({
  seed: process.env.CONTINUUM_SEED !== "0",
});
const url = await app.listen({
  host: "127.0.0.1",
  port: Number(process.env.PORT || 4317),
});
console.log("Continuum " + url);
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    app.server.closeAllConnections();
    void app.close();
  });
