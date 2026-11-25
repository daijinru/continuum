import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { now, type Store } from "./db.ts";
import type { MonitorSnapshot } from "../../../packages/contracts/src/monitor.ts";

type Processes = NonNullable<MonitorSnapshot["processes"]>;
const exec = promisify(execFile);

export function processTree(
  text: string,
  root: number,
  sampler: number | undefined,
  runs: Map<number, string>,
): Processes | null {
  type Sample = { pid: number; cpu: number; rssMiB: number };
  const children = new Map<number, Sample[]>();
  let service: Sample | undefined;
  for (const line of text.trim().split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 4) continue;
    const [pid, ppid, cpu, rss] = fields.map(Number);
    if (
      pid === sampler ||
      ![pid, ppid, cpu, rss].every((n) => Number.isFinite(n) && n >= 0)
    )
      continue;
    const row = { pid, cpu, rssMiB: rss / 1024 };
    if (pid === root) service = row;
    else {
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid)!.push(row);
    }
  }
  if (!service) return null;
  const tree: Processes = [{ ...service, role: "service", runId: null }];
  for (const parent of tree) {
    for (const child of children.get(parent.pid) || []) {
      tree.push({
        ...child,
        role: runs.has(child.pid) ? "executor" : "helper",
        runId: runs.get(child.pid) ?? parent.runId,
      });
    }
  }
  return tree;
}

async function sample(runs: Map<number, string>) {
  const sampledAt = now();
  let processes: MonitorSnapshot["processes"] = null;
  if (process.platform === "darwin" || process.platform === "linux") {
    try {
      // No command lines, environment, paths or arguments. Exclude ps itself.
      const ps = exec("/bin/ps", ["-axo", "pid=,ppid=,pcpu=,rss="], {
        timeout: 1800,
        maxBuffer: 2_000_000,
        env: { LC_ALL: "C" },
      });
      processes = processTree(
        (await ps).stdout,
        process.pid,
        ps.child.pid,
        runs,
      );
    } catch {
      /* An unavailable sample is not an idle machine. */
    }
  }
  return { sampledAt, processes };
}

// Multiple tabs share the same short-lived sample, including in-flight reads.
export function processSampler(roots: () => Map<number, string>) {
  let previous: ReturnType<typeof sample> | undefined,
    expires = 0;
  return () => {
    if (!previous || Date.now() >= expires) {
      previous = sample(roots());
      expires = Date.now() + 3000;
    }
    return previous;
  };
}

export function monitorTasks(
  db: Store,
  watching: ReadonlyMap<string, unknown>,
) {
  // One row per commission even with multiple queued messages or legacy schedules.
  const rows = db.all(`
    WITH queued AS (SELECT DISTINCT goal_id FROM user_messages WHERE status IN('queued','dispatching')),
    schedules AS (SELECT goal_id, MIN(next_at) next_at FROM schedule_jobs WHERE state='enabled' GROUP BY goal_id)
    SELECT g.id,g.title,g.state,g.provider,r.id runId,r.status, q.goal_id queued,
      COALESCE(t.next_at, j.next_at) nextAt
    FROM goals g
    LEFT JOIN agent_runs r ON r.goal_id=g.id AND r.finished IS NULL
    LEFT JOIN main_tasks t ON t.goal_id=g.id
    LEFT JOIN schedules j ON j.goal_id=g.id
    LEFT JOIN queued q ON q.goal_id=g.id
    WHERE g.state IN('active','paused','blocked') OR r.id IS NOT NULL OR t.mode='trending'
    ORDER BY g.updated DESC`);
  return rows
    .filter(
      (r) =>
        ["active", "paused", "blocked"].includes(r.state) ||
        r.runId ||
        watching.has(r.id),
    )
    .map((r) => ({
      id: r.id,
      title: r.title,
      runId: r.runId,
      demo: r.provider === "demo",
      nextAt: r.state === "active" ? r.nextAt : null,
      // Pausing future schedules does not interrupt work already in flight.
      state:
        r.status ??
        (watching.has(r.id)
          ? "watching"
          : r.state !== "active"
            ? r.state
            : r.queued
              ? "queued"
              : r.nextAt
                ? "scheduled"
                : "idle"),
    }));
}
