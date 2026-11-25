import { type Store, uid } from "./db.ts";
import type { TokenCounts } from "../../../packages/agent-core/src/index.ts";

export function recordUsage(
  db: Store,
  source: string,
  goal: string | null,
  u: TokenCounts,
) {
  if (
    ![u.input, u.output, u.total].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    )
  )
    return;
  db.run(
    `INSERT INTO token_usage(source,goal_id,input,output,total) VALUES(?,?,?,?,?)
    ON CONFLICT(source) DO UPDATE SET input=excluded.input,output=excluded.output,total=excluded.total
    WHERE token_usage.goal_id IS excluded.goal_id AND excluded.total >= token_usage.total`,
    source,
    goal,
    u.input,
    u.output,
    u.total,
  );
}

// Each real invocation (including retries after a failed interpretation) can incur usage.
export function execMeter(db: Store, goal: string | null) {
  const source = "exec:" + uid();
  return (u: TokenCounts) => recordUsage(db, source, goal, u);
}

const sums =
  "SELECT SUM(input) input, SUM(output) output, SUM(total) total FROM token_usage";
export function goalUsage(db: Store, id: string) {
  return db.must(sums + " WHERE goal_id=?", id);
}
export function workspaceUsage(db: Store) {
  return {
    conversation: db.must(sums + " WHERE goal_id IS NULL"),
    goals: db.must(sums + " WHERE goal_id IS NOT NULL"),
    all: db.must(sums),
  };
}
