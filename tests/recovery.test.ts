import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../apps/api/src/server.ts";
import { uid, now } from "../apps/api/src/db.ts";
import type {
  AgentAdapter,
  Context,
} from "../packages/agent-core/src/index.ts";
const temp = () => mkdtempSync(join(tmpdir(), "continuum-recovery-"));
test("输入请求和失联后的人工核对不能充当命令批准", async () => {
  const { app, db, s } = await createServer({
    home: temp(),
    seed: false,
    worker: false,
  });
  try {
    const w = db.workspace(temp()),
      g = s.createGoal({
        workspaceId: w.id,
        provider: "codex",
        title: "隔离任务",
        description: "协议夹具",
        criteria: ["核对"],
        constraints: [],
        priority: 3,
      });
    let context!: Context,
      answers: Record<string, string> = {};
    const adapter: AgentAdapter = {
      async start(c) {
        context = c;
        c.reference("fixture-thread", "fixture-turn");
        c.emit({ key: "start", type: "run.started", title: "开始" });
      },
      async respond() {
        throw Error("不应批准");
      },
      async answer(_id, _request, a) {
        answers = a;
      },
      async reconcile() {
        return "unknown";
      },
      async interrupt() {},
      close() {},
    };
    s.adapters.codex = adapter;
    const r = await s.start(g.id, uid());
    context.emit({
      key: "input",
      type: "input.requested",
      title: "选择格式",
      approval: {
        kind: "input",
        id: "7",
        action: JSON.stringify([{ id: "format", question: "输出格式" }]),
        reason: "等待选择",
        scope: "当前任务",
        risk: "需输入",
      },
    });
    const i = db.must("SELECT * FROM inbox_items WHERE kind='input'");
    await assert.rejects(
      s.decide(i.id, { decision: "approve", version: 1, key: uid() }),
    );
    await assert.rejects(
      s.decide(i.id, {
        decision: "answer",
        version: 1,
        key: uid(),
        answers: { other: "x" },
      }),
    );
    await s.decide(i.id, {
      decision: "answer",
      version: 1,
      key: uid(),
      answers: { format: "Markdown" },
    });
    assert.deepEqual(answers, { format: "Markdown" });
    assert.equal(s.run(r.id).status, "running");
    context.emit({
      key: "loss",
      type: "system.disconnected",
      title: "连接已断开",
    });
    const decision = db.must("SELECT * FROM inbox_items WHERE kind='decision'");
    assert.equal(s.run(r.id).status, "unknown");
    await s.decide(decision.id, {
      decision: "record",
      observed: "failed",
      note: "已核对提供方终态",
      version: 1,
      key: uid(),
    });
    assert.equal(s.run(r.id).status, "failed");
    const briefing = db.must(
      "SELECT snapshot FROM briefings ORDER BY rowid DESC LIMIT 1",
    );
    const risk = JSON.parse(briefing.snapshot).sections.changes.find(
      (story: { category: string }) => story.category === "risk",
    );
    assert.equal(risk.verification, "disputed");
    assert.match(risk.summary, /失败/);
    assert.equal(s.inbox(decision.id).status, "resolved");
  } finally {
    await app.close();
  }
});
test("迁移后原目录失效：保留历史并关闭旧审批，不重跑任务", async () => {
  const home = temp();
  let server = await createServer({ home, worker: false });
  const item = server.db.must("SELECT * FROM inbox_items");
  await server.app.close();
  renameSync(join(home, "demo-project"), join(home, "moved"));
  server = await createServer({ home, worker: false });
  try {
    assert.equal(server.s.run(item.run_id).status, "interrupted");
    assert.equal(server.s.inbox(item.id).status, "expired");
    await assert.rejects(
      server.s.decide(item.id, {
        key: uid(),
        decision: "approve",
        version: item.version,
      }),
      /状态已变化/,
    );
    assert.equal(server.db.all("SELECT id FROM agent_runs").length, 1);
    assert.equal((await server.app.inject("/api/v1/goals")).statusCode, 200);
  } finally {
    await server.app.close();
  }
});
test("重启回收过期租约，已经派发的计划时段不再执行", async () => {
  const home = temp();
  let server = await createServer({ home, worker: false });
  const goal = server.db.must("SELECT * FROM goals"),
    job = uid(),
    slot = now();
  server.db.run(
    "INSERT INTO schedule_jobs(id,goal_id,kind,instruction,minutes,next_at,state,lease,lease_until) VALUES(?,?,'one_off','恢复验证',1,?,'enabled','old-owner','2000-01-01')",
    job,
    goal.id,
    slot,
  );
  server.db.run("UPDATE agent_runs SET key=?", "job:" + job + ":" + slot);
  await server.app.close();
  server = await createServer({ home, worker: false });
  try {
    await server.worker.tick();
    assert.equal(server.db.all("SELECT * FROM agent_runs").length, 1);
    assert.equal(
      server.db.must("SELECT * FROM schedule_jobs WHERE id=?", job).state,
      "disabled",
    );
  } finally {
    await server.app.close();
  }
});
