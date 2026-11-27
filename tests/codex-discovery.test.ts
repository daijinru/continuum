import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { checkCodex } from "../packages/codex-adapter/src/index.ts";
import { interpret } from "../apps/api/src/main-model.ts";

test(
  "macOS 精简 PATH 可使用桌面应用自带的 Codex，并优先使用已配置的 CLI",
  {
    skip: process.platform !== "darwin",
  },
  async (t) => {
    const home = mkdtempSync(join(tmpdir(), "continuum-cli-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const bin = join(home, "bin");
    mkdirSync(bin);
    const oldHome = process.env.HOME,
      oldPath = process.env.PATH;
    t.after(() => {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    });
    process.env.HOME = home;
    process.env.PATH = bin;
    const bundled = join(
      home,
      "Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS",
    );
    const fakeCli = (dir: string, version: string) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "codex"),
        `#!${process.execPath}
const cmd = process.argv[2];
if (cmd === "--version") console.log(${JSON.stringify(version)});
else if (cmd === "login") console.log("Logged in");
else if (cmd === "app-server") {
  require("node:readline").createInterface({input:process.stdin}).on("line", line => {
    const {id,method} = JSON.parse(line);
    if (id !== undefined) console.log(JSON.stringify({id,result:method === "account/read" ? {account:{}} : {}}));
  });
} else if (cmd === "exec") {
  require("node:fs").writeFileSync("answer.json", JSON.stringify({actions:[{type:"talk",target:"",text:"你好",at:"",cadence:"once",notify:"always"}]}));
} else process.exitCode = 1;
`,
        { mode: 0o700 },
      );
    };
    fakeCli(bundled, "bundled");
    const connection = await checkCodex();
    assert.equal(connection.version, "bundled", connection.detail);
    assert.equal(connection.ready, true, connection.detail);
    assert.equal((await interpret({ text: "你好" }, () => {}))[0].type, "talk");
    fakeCli(bin, "configured");
    assert.equal((await checkCodex()).version, "configured");
  },
);
