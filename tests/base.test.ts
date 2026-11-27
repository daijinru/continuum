import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../apps/api/src/db.ts";
import { canMove, redact } from "../packages/agent-core/src/index.ts";
test("数据库迁移可重复打开，同时只允许一个服务持有数据目录", () => {
  const path = mkdtempSync(join(tmpdir(), "continuum-"));
  const db = new Store(path);
  assert.throws(() => new Store(path));
  db.close();
  const reopened = new Store(path);
  assert.equal(reopened.all("SELECT * FROM schema_migrations").length, 16);
  reopened.close();
});
test("终态和未知态转换，凭据脱敏", () => {
  assert.equal(canMove("succeeded", "running"), false);
  assert.equal(canMove("unknown", "succeeded"), true);
  assert.equal(redact("token=abcdef"), "token=[已隐藏]");
});
