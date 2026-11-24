import { defineConfig } from "@playwright/test";
import { mkdtempSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const home = mkdtempSync(join(tmpdir(), "continuum-browser-"));
export default defineConfig({
  testDir: "tests/browser",
  workers: 1,
  timeout: 45000,
  use: {
    baseURL: "http://127.0.0.1:4389",
    viewport: { width: 1440, height: 1000 },
    launchOptions: {
      executablePath:
        process.env.CHROME_PATH || (existsSync(chrome) ? chrome : undefined),
    },
  },
  webServer: {
    command: JSON.stringify(process.execPath) + " apps/api/src/main.ts",
    env: { PORT: "4389", CONTINUUM_DATA: home, PATH: home },
    url: "http://127.0.0.1:4389/api/v1/health",
    reuseExistingServer: false,
    timeout: 20000,
  },
});
