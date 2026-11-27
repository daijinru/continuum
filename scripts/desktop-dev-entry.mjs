// Keep Electron's default startup error dialog from blocking the next edit.
import { app } from "electron";
try {
  await import("../apps/desktop/main.mjs");
} catch (err) {
  console.error(err);
  app.exit(1);
}
