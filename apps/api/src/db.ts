import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  accessSync,
  constants,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  chmodSync,
} from "node:fs";
import { resolve, basename, isAbsolute, relative } from "node:path";
import { randomUUID } from "node:crypto";
export type Row = Record<string, any>;
export const uid = randomUUID;
export const now = () => new Date().toISOString();
export class Problem extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 422) {
    super(message);
    this.statusCode = statusCode;
  }
}
// An unavailable stored location can be recovered before dispatch. A disabled
// workspace is a separate user decision and must never enter this retry path.
export class DirectoryUnavailable extends Problem {}
export function directory(path: string) {
  if (!isAbsolute(path) || path.split("/").includes(".."))
    throw new Problem("请输入无上级跳转的绝对目录");
  try {
    const real = realpathSync(path);
    if (!statSync(real).isDirectory()) throw Error();
    accessSync(real, constants.R_OK | constants.X_OK);
    return real;
  } catch {
    throw new DirectoryUnavailable("项目文件夹找不到或无法访问");
  }
}
export function verifiedFile(root: string, path: string) {
  try {
    const actual = realpathSync(resolve(root, path));
    const rel = relative(root, actual);
    if (
      rel &&
      !rel.startsWith("../") &&
      rel !== ".." &&
      !isAbsolute(rel) &&
      statSync(actual).isFile()
    )
      return actual;
  } catch {
    /* claimed artifact may not exist */
  }
  return null;
}
export class Store {
  db: DatabaseSync;
  lock: DatabaseSync;
  home: string;
  constructor(home = process.env.CONTINUUM_DATA || ".local") {
    this.home = resolve(home);
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    this.lock = new DatabaseSync(resolve(this.home, "owner.lock.sqlite"));
    try {
      this.lock.exec("BEGIN EXCLUSIVE");
    } catch {
      this.lock.close();
      throw new Problem("此数据目录已有服务在运行", 409);
    }
    this.db = new DatabaseSync(resolve(this.home, "continuum.sqlite"));
    chmodSync(resolve(this.home, "continuum.sqlite"), 0o600);
    this.db.exec(
      "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000",
    );
    for (const [index, file] of [
      "001_initial.sql",
      "002_goal_limits.sql",
      "003_checks.sql",
      "004_inbox_kinds.sql",
      "005_message_context.sql",
      "006_managed_commissions.sql",
      "007_main_conversation.sql",
      "008_token_usage.sql",
      "009_project_authorizations.sql",
      "010_directory_holds.sql",
      "011_run_approvals.sql",
      "012_goal_approval_grants.sql",
      "013_command_review.sql",
    ].entries()) {
      const version = index + 1;
      const migrated =
        this.one(
          "SELECT 1 FROM sqlite_master WHERE name='schema_migrations'",
        ) &&
        this.one("SELECT 1 FROM schema_migrations WHERE version=?", version);
      if (migrated) continue;
      this.tx(() => {
        this.db.exec(
          readFileSync(
            new URL("../../../migrations/" + file, import.meta.url),
            "utf8",
          ),
        );
        this.run("INSERT INTO schema_migrations VALUES(?,?)", version, now());
      });
    }
  }
  run(sql: string, ...args: SQLInputValue[]) {
    return this.db.prepare(sql).run(...args);
  }
  one(sql: string, ...args: SQLInputValue[]): Row | undefined {
    return this.db.prepare(sql).get(...args);
  }
  all(sql: string, ...args: SQLInputValue[]): Row[] {
    return this.db.prepare(sql).all(...args);
  }
  must(sql: string, ...args: SQLInputValue[]): Row {
    const row = this.one(sql, ...args);
    if (!row) throw new Problem("记录不存在", 404);
    return row;
  }
  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  workspace(path: string, name?: string, authorize = true) {
    const real = directory(path);
    this.run(
      "INSERT INTO workspaces VALUES(?,?,?,1) ON CONFLICT(path) DO UPDATE SET enabled=1, name=coalesce(?,workspaces.name)",
      uid(),
      name || basename(real),
      real,
      name || null,
    );
    const workspace = this.must("SELECT * FROM workspaces WHERE path=?", real);
    if (authorize)
      this.run(
        "INSERT OR IGNORE INTO authorized_projects VALUES(?)",
        workspace.id,
      );
    return workspace;
  }
  projects() {
    return this
      .all(`SELECT w.*, (SELECT count(*) FROM goals g WHERE g.workspace_id=w.id
      AND g.state NOT IN ('completed','archived')) affected
      FROM authorized_projects p JOIN workspaces w ON w.id=p.workspace_id ORDER BY w.name,w.path`);
  }
  enabledWorkspace(id: string) {
    const w = this.must("SELECT * FROM workspaces WHERE id=?", id);
    if (!w.enabled) throw new Problem("项目已停用，请先在设置中重新启用。");
    return w;
  }
  allowed(id: string) {
    const w = this.enabledWorkspace(id);
    if (directory(w.path) !== w.path)
      throw new DirectoryUnavailable("项目文件夹指向的位置已改变");
    return w.path as string;
  }
  close() {
    this.db.close();
    this.lock.close();
  }
}
