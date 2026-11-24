import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../apps/api/src/server.ts";
import { generate, acknowledge } from "../packages/briefing/src/index.ts";
import type { Context } from "../packages/agent-core/src/index.ts";

test("一句话委托只派发一次；读过过程后仍交付结果；新偏好仅用于下一次", async () => {
  const { app, db, s, worker, token } = await createServer({
    home: mkdtempSync(join(tmpdir(), "commission-")),
    worker: false,
    seed: false,
  });
  const post = async (path: string, payload: object) => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1" + path,
      headers: { "x-continuum-token": token },
      payload,
    });
    assert.equal(res.statusCode, 200, res.body);
    return res.json().data;
  };
  let ctx!: Context,
    starts = 0;
  s.adapters.codex = {
    ...s.adapters.codex,
    async start(c) {
      ctx = c;
      starts++;
      c.emit({ key: "start", type: "run.started", title: "开始" });
    },
    async interrupt() {},
    async respond() {},
    async reconcile() {
      return "unknown";
    },
    close() {},
  };
  try {
    const payload = { request: "汇总今天的重要新闻", key: crypto.randomUUID() };
    const g = await post("/commissions", payload);
    assert.equal((await post("/commissions", payload)).id, g.id);
    assert.ok(db.allowed(g.workspace_id).startsWith(realpathSync(db.home) + "/commissions/"));
    await worker.tick();
    await worker.tick();
    assert.equal(starts, 1);
    assert.equal(ctx.managedCommission,true);
    ctx.emit({ key: "draft", type: "agent.message", title: "先检查来源" });
    ctx.emit({ key: "answer", type: "agent.message", title: "今日汇总与来源" });
    const before = generate(db);
    assert.deepEqual(before.reports, []);
    acknowledge(db, before.id);
    ctx.emit({ key: "done", type: "run.completed", title: "结束" });
    const brief = generate(db);
    assert.equal(brief.reports.length, 1);
    assert.equal(brief.reports[0].summary, "今日汇总与来源");
    const url = `/goals/${g.id}`;
    await post(url + "/preferences", { text: "优先实用产品" });
    await worker.tick();
    assert.equal(starts, 1);
    assert.deepEqual(
      (await app.inject("/api/v1" + url + "/reports"))
        .json()
        .data.map((r: { id: string }) => r.id),
      [brief.reports[0].id],
    );
    await post(url + "/start", { key: crypto.randomUUID() });
    assert.match(ctx.instruction, /优先实用产品/);
    assert.equal(ctx.managedCommission,true);
    // Explicitly selecting even the same directory is not a grant to the new goal.
    await post("/commissions",{request:"在已有项目中工作",key:crypto.randomUUID(),workspaceId:g.workspace_id});
    await worker.tick();
    assert.equal(ctx.managedCommission,false);
  } finally {
    await app.close();
  }
});
