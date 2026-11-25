import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../apps/api/src/server.ts";
import { processTree } from "../apps/api/src/monitor.ts";
import type { MonitorSnapshot } from "../packages/contracts/src/monitor.ts";

test("仅统计服务子树；排除采样自身、无关会话，子进程继承执行器归属", () => {
  const ps = `81 35 0.4 2048
    205 40 1.0 9999
    30 1 0.5 1024
    35 30 105.6 4096
    11 30 0.0 200
    25 30 0.0 500
    40 1 95.0 6000`;
  const roots = new Map([
    [35, "run-a"],
    [40, "not-ours"],
  ]);
  const result = processTree(ps, 30, 11, roots)!;
  assert.deepEqual(result, [
    { pid: 30, role: "service", runId: null, cpu: 0.5, rssMiB: 1 },
    { pid: 35, role: "executor", runId: "run-a", cpu: 105.6, rssMiB: 4 },
    { pid: 25, role: "helper", runId: null, cpu: 0, rssMiB: 500 / 1024 },
    { pid: 81, role: "helper", runId: "run-a", cpu: 0.4, rssMiB: 2 },
  ]);
  assert.equal(processTree(ps, 99, 11, roots), null);
});

test("只读监测区分在途、排队、等待、失联、暂停与原生排期", async () => {
  const home = mkdtempSync(join(tmpdir(), "continuum-monitor-"));
  const { app, s, db, agenda } = await createServer({
    home,
    worker: false,
    seed: false,
  });
  async function snapshot(): Promise<MonitorSnapshot> {
    const r = await app.inject("/api/v1/system/monitor");
    assert.equal(r.statusCode, 200, r.body);
    return r.json().data;
  }
  try {
    const work = s.commission("待派发的委托", crypto.randomUUID());
    const watch = s.commission("查看榜单", crypto.randomUUID());
    db.run("DELETE FROM user_messages WHERE goal_id=?", watch.id);
    db.run(
      "INSERT INTO main_tasks(goal_id,mode,cadence,clock,next_at,notify) VALUES(?,'trending','daily','09:00',?,'always')",
      watch.id,
      "2099-01-01T09:00:00.000Z",
    );
    const a = await snapshot();
    assert.deepEqual(a.tasks.map((t) => t.state).sort(), [
      "queued",
      "scheduled",
    ]);
    if (["darwin", "linux"].includes(process.platform)) {
      assert.equal(a.processes?.[0].pid, process.pid);
      assert.ok(a.processes[0].rssMiB > 0);
    }
    assert.equal(db.all("SELECT id FROM agent_runs").length, 0);
    assert.equal(db.all("SELECT id FROM main_messages").length, 0);
    const run = s.reserve(work, crypto.randomUUID(), "示例", null);
    db.run("UPDATE goals SET state='paused' WHERE id=?", work.id);
    agenda.active.set(watch.id, Promise.resolve());
    const b = await snapshot();
    assert.equal(b.tasks.find((t) => t.id === work.id)?.state, "starting");
    assert.equal(b.tasks.find((t) => t.id === watch.id)?.state, "watching");
    s.move(run, "running");
    s.move(s.run(run.id), "waiting_approval");
    assert.equal(
      (await snapshot()).tasks.find((t) => t.id === work.id)?.state,
      "waiting_approval",
    );
    s.move(s.run(run.id), "unknown");
    assert.equal(
      (await snapshot()).tasks.find((t) => t.id === work.id)?.state,
      "unknown",
    );
    s.move(s.run(run.id), "interrupted");
    assert.equal(
      (await snapshot()).tasks.find((t) => t.id === work.id)?.state,
      "paused",
    );
    assert.equal(db.all("SELECT id FROM agent_runs").length, 1);
  } finally {
    await app.close();
    rmSync(home, { recursive: true, force: true });
  }
});
