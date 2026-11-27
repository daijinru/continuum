import type {
  Workload,
  ModelSelection,
} from "../../../packages/agent-core/src/index.ts";
import { type Store, now, uid } from "./db.ts";
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
  let source = "exec:" + uid();
  return Object.assign(
    (u: TokenCounts) => {
      db.tx(() => {
        recordUsage(db, source, goal, u);
        db.run(
          "UPDATE model_calls SET total=(SELECT total FROM token_usage WHERE source=?) WHERE source=?",
          source,
          source,
        );
      });
    },
    {
      begin(choice: ModelSelection, workload: Workload) {
        source = "exec:" + uid();
        recordChoice(db, source, goal ? "筛选" : "理解消息", workload, choice);
      },
      end(ok: boolean) {
        db.run(
          "UPDATE model_calls SET finished=?,outcome=? WHERE source=?",
          now(),
          ok ? "succeeded" : "failed",
          source,
        );
      },
    },
  );
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

export function recordChoice(
  db: Store,
  source: string,
  kind: string,
  workload: Workload,
  choice: ModelSelection,
) {
  db.run(
    `INSERT INTO model_calls(source,kind,workload,model,effort,fallback,started)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(source) DO UPDATE SET
    model=excluded.model,effort=excluded.effort,fallback=excluded.fallback`,
    source,
    kind,
    workload,
    choice.model ?? null,
    choice.effort ?? null,
    Number(!!choice.fallback),
    now(),
  );
}

export function recentCalls(db: Store) {
  return db.all(`SELECT c.kind,c.workload,c.model,c.effort,c.fallback,c.started,c.total,
    coalesce(r.finished,c.finished) finished,coalesce(r.status,c.outcome) outcome
    FROM model_calls c LEFT JOIN agent_runs r ON r.id=c.source ORDER BY c.seq DESC LIMIT 20`);
}
