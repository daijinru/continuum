import {
  directory,
  DirectoryUnavailable,
  now,
  Problem,
  uid,
  type Row,
  type Store,
} from "./db.ts";
import { post } from "./main-messages.ts";

export function pendingDirectory(db: Store, goalId: string) {
  return db.one(
    "SELECT * FROM directory_holds WHERE goal_id=? AND resolved_at IS NULL",
    goalId,
  );
}

// Called in the same transaction that retains the original dispatch.
export function holdDirectory(db: Store, goal: Row, reason: string) {
  const notice = post(
    db,
    "assistant",
    "directory",
    `「${goal.title}」本次工作还没开始，${reason}。恢复原目录后会自动继续。如果项目已搬走，可以在这里为这项委托确认新位置。`,
    [goal.id],
    "directory:" + uid(),
  );
  db.run(
    "INSERT INTO directory_holds(notice_id,goal_id,workspace_id,reason) VALUES(?,?,?,?)",
    notice,
    goal.id,
    goal.workspace_id,
    reason,
  );
}

// The caller commits any user decision along with the release. The original
// queue entry or schedule is the only thing that can dispatch the work.
export function releaseDirectory(
  db: Store,
  hold: Row,
  user: string | null,
  path?: string,
) {
  const goal = db.must("SELECT * FROM goals WHERE id=?", hold.goal_id);
  if (goal.state !== "active" || goal.workspace_id !== hold.workspace_id)
    throw new Problem("委托已暂停、结束或变更，请先查看当前状态。", 409);
  db.enabledWorkspace(goal.workspace_id);
  let workspaceId = goal.workspace_id;
  if (path) {
    const real = directory(path);
    // This confirmation belongs to this goal. Do not rename a shared grant,
    // enable a disabled project, or grant future commissions access to it.
    workspaceId =
      db.one("SELECT id FROM workspaces WHERE path=?", real)?.id ??
      db.workspace(real, undefined, false).id;
  }
  const location = db.allowed(workspaceId);
  db.run(
    "UPDATE goals SET workspace_id=?,updated=? WHERE id=?",
    workspaceId,
    now(),
    goal.id,
  );
  db.run(
    "UPDATE directory_holds SET resolved_at=?,resolved_by=?,replacement_path=? WHERE notice_id=?",
    now(),
    user,
    path ?? null,
    hold.notice_id,
  );
  return `「${goal.title}」的目录已确认，原工作将继续使用 ${location}。`;
}

export function checkRestoredDirectories(db: Store) {
  const holds =
    db.all(`SELECT h.* FROM directory_holds h JOIN goals g ON g.id=h.goal_id
    JOIN workspaces w ON w.id=h.workspace_id WHERE h.resolved_at IS NULL
    AND g.state='active' AND g.workspace_id=w.id AND w.enabled=1`);
  for (const hold of holds) {
    try {
      db.tx(() => releaseDirectory(db, hold, null));
    } catch (e) {
      if (!(e instanceof DirectoryUnavailable)) throw e;
    }
  }
}
