import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  renameSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "../apps/api/src/server.ts";
import { uid, now, verifiedFile } from "../apps/api/src/db.ts";
import {
  generate,
  acknowledge,
  score,
} from "../packages/briefing/src/index.ts";
import { redact } from "../packages/agent-core/src/index.ts";
const temp = () => mkdtempSync(join(tmpdir(), "continuum-test-"));
async function setup(t: TestContext) {
  const server = await createServer({ home: temp(), worker: false, delay: 2 });
  t.after(() => server.app.close());
  return server;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
test("演示审批、审计、不可变简报及已读游标", async (t) => {
  const { s, db } = await setup(t),
    i = db.must("SELECT * FROM inbox_items"),
    before = generate(db),
    again = generate(db);
  assert.equal(before.id, again.id);
  assert.equal(before.sections.needs.length, 1);
  assert.equal(before.sections.outcomes.length, 1);
  assert.equal(before.sections.changes[0].verification, "disputed");
  assert.equal(db.must("SELECT * FROM attention_cursors").seq, 0);
  assert.ok(score(1, 1, 1, 1, 5) > score(0.2, 0, 1, 0, 1));
  const key = uid(),
    d = { key, decision: "approve", version: 1 };
  const concurrent = await Promise.allSettled([
    s.decide(i.id, d),
    s.decide(i.id, d),
  ]);
  assert.equal(concurrent.filter((x) => x.status === "fulfilled").length, 1);
  await s.decide(i.id, d);
  await sleep(25);
  assert.equal(s.run(i.run_id).status, "succeeded");
  assert.equal(db.all("SELECT * FROM audit_log").length, 1);
  const newB = generate(db);
  assert.equal(newB.sections.needs.length, 0);
  assert.equal(newB.sections.outcomes.length, 2);
  assert.equal(
    JSON.parse(
      db.must("SELECT snapshot FROM briefings WHERE id=?", before.id).snapshot,
    ).sections.needs.length,
    1,
  );
  const path = db.must("SELECT * FROM stories WHERE unit='demo:path'");
  assert.equal(path.verification, "verified");
  assert.equal(
    db.all("SELECT * FROM story_events WHERE story_id=?", path.id).length,
    3,
  );
  acknowledge(db, newB.id);
  const quiet = generate(db);
  assert.equal(quiet.quiet, true);
  assert.equal(quiet.count, 0);
  acknowledge(db, before.id);
  assert.equal(db.must("SELECT * FROM attention_cursors").seq, newB.end_seq);
});
test("稍后处理、过期版本、拒绝与连接丢失", async (t) => {
  const { s, db } = await setup(t),
    i = db.must("SELECT * FROM inbox_items");
  await s.decide(i.id, { decision: "defer", version: 1, key: uid() });
  assert.equal(s.run(i.run_id).status, "waiting_approval");
  await assert.rejects(
    s.decide(i.id, { decision: "approve", version: 1, key: uid() }),
    /状态已变化/,
  );
  await s.decide(i.id, { decision: "deny", version: 2, key: uid() });
  await sleep(20);
  assert.equal(s.run(i.run_id).status, "interrupted");
  const r = await s.start(i.goal_id, uid());
  await sleep(20);
  const item = db.must("SELECT * FROM inbox_items WHERE run_id=?", r.id);
  s.event(r.id, {
    key: "loss",
    type: "system.disconnected",
    title: "连接中断",
  });
  assert.equal(s.run(r.id).status, "unknown");
  assert.equal(s.inbox(item.id).status, "expired");
  await assert.rejects(
    s.decide(item.id, { decision: "approve", version: 1, key: uid() }),
  );
});
test("过期请求不会发送给提供方", async (t) => {
  const { s, db } = await setup(t),
    i = db.must("SELECT * FROM inbox_items");
  db.run("UPDATE inbox_items SET expires='2000-01-01' WHERE id=?", i.id);
  await assert.rejects(
    s.decide(i.id, { decision: "approve", version: 1, key: uid() }),
    /过期/,
  );
  assert.equal(s.inbox(i.id).status, "expired");
});
test("重复和乱序事件保留正确证据；新失败可推翻旧通过", async (t) => {
  const { s, db } = await setup(t),
    r = db.must("SELECT * FROM agent_runs");
  const e = {
    key: "new-pass",
    type: "test.completed",
    unit: "path",
    title: "通过",
    data: { passed: true },
  };
  s.event(r.id, e);
  s.event(r.id, e);
  assert.equal(db.all("SELECT 1 FROM raw_events WHERE title='通过'").length, 1);
  s.event(r.id, {
    ...e,
    key: "late",
    title: "迟到的失败",
    time: "2020-01-01T00:00:00Z",
    data: { passed: false },
  });
  assert.equal(
    db.must("SELECT * FROM stories WHERE unit='demo:path'").verification,
    "verified",
  );
  s.event(r.id, { ...e, key: "regression", data: { passed: false } });
  assert.equal(
    db.must("SELECT * FROM stories WHERE unit='demo:path'").verification,
    "disputed",
  );
  s.event(r.id, {
    key: "claims",
    type: "agent.message",
    title: "已创建文件 token=secret-value",
    data: { Authorization: "Bearer xyz" },
  });
  const text = JSON.stringify(db.all("SELECT * FROM raw_events"));
  assert.ok(!text.includes("secret-value"));
  assert.ok(!text.includes("Bearer xyz"));
  assert.equal(
    db.must("SELECT * FROM stories WHERE category='insight'").verification,
    "reported",
  );
  assert.equal(redact("Authorization: Bearer abc"), "Authorization: [已隐藏]");
  assert.equal(db.all("SELECT * FROM artifacts").length, 0);
});
test("完整 API 新目标流程、并发隔离和作用域", async (t) => {
  const { app, db, token, s } = await setup(t);
  const goal = db.must("SELECT * FROM goals");
  const post = (p: string, b: object) =>
    app.inject({
      method: "POST",
      url: "/api/v1" + p,
      headers: { "x-continuum-token": token },
      payload: b,
    });
  const g = (
    await post("/goals", {
      title: "独立目标",
      description: "测试",
      criteria: ["验收"],
      workspaceId: goal.workspace_id,
      provider: "demo",
    })
  ).json().data;
  const key = uid();
  const run = (await post("/goals/" + g.id + "/start", { key })).json().data;
  assert.ok(run.id);
  assert.equal(
    (await post("/goals/" + g.id + "/start", { key })).json().data.id,
    run.id,
  );
  assert.equal(
    (await post("/goals/" + g.id + "/start", { key: uid() })).statusCode,
    409,
  );
  await sleep(30);
  const i = db.must("SELECT * FROM inbox_items WHERE goal_id=?", g.id);
  assert.equal(i.run_id, run.id);
  assert.equal(
    (
      await post("/chat/messages", {
        scope: "approval",
        ref: i.id,
        goalId: goal.id,
        content: "跨目标",
      })
    ).statusCode,
    422,
  );
  assert.equal(
    (
      await post("/inbox/" + i.id + "/decision", {
        decision: "approve",
        version: 1,
        key: uid(),
      })
    ).statusCode,
    200,
  );
  await sleep(20);
  assert.equal(s.run(run.id).status, "succeeded");
  assert.equal(
    s.run(db.must("SELECT * FROM agent_runs WHERE goal_id=?", goal.id).id)
      .status,
    "waiting_approval",
  );
  const continued = (
    await post("/goals/" + g.id + "/start", { key: uid(), continue: true })
  ).json().data;
  assert.notEqual(continued.id, run.id);
  assert.equal(continued.thread_id, run.thread_id);
  assert.notEqual(continued.turn_id, run.turn_id);
});
test("目录白名单阻止上级跳转和符号链接替换，文件核验限于项目内", async (t) => {
  const { db } = await setup(t),
    root = temp(),
    project = join(root, "original"),
    other = join(root, "other");
  mkdirSync(project);
  mkdirSync(other);
  writeFileSync(join(other, "secret"), "x");
  assert.throws(() => db.workspace(project + "/../other"));
  const w = db.workspace(project);
  symlinkSync(other, join(project, "link"));
  assert.equal(verifiedFile(project, "link/secret"), null);
  renameSync(project, project + "-old");
  symlinkSync(other, project);
  assert.throws(() => db.allowed(w.id));
  db.run("UPDATE workspaces SET enabled=0 WHERE id=?", w.id);
  assert.throws(() => db.allowed(w.id));
});
test("重启保留收件箱、简报和事件，DEMO 可继续处理", async () => {
  const home = temp();
  let r = await createServer({ home, worker: false, delay: 1 });
  const item = r.db.must("SELECT * FROM inbox_items"),
    count = r.db.all("SELECT * FROM raw_events").length,
    brief = generate(r.db);
  await r.app.close();
  r = await createServer({ home, worker: false, delay: 1 });
  try {
    assert.equal(generate(r.db).id, brief.id);
    assert.equal(r.db.all("SELECT * FROM raw_events").length, count);
    await r.s.decide(item.id, { decision: "approve", key: uid(), version: 1 });
    await sleep(20);
    assert.equal(r.s.run(item.run_id).status, "succeeded");
  } finally {
    await r.app.close();
  }
});
test("定时任务租约、暂停、每日额度、重启幂等与失败退避", async (t) => {
  const { s, worker, db } = await setup(t);
  const g = db.must("SELECT * FROM goals"),
    item = db.must("SELECT * FROM inbox_items");
  await s.decide(item.id, { decision: "deny", version: 1, key: uid() });
  await sleep(15);
  const id = uid();
  db.run(
    "INSERT INTO schedule_jobs(id,goal_id,kind,instruction,minutes,next_at,state) VALUES(?,?,'one_off','测试',2,?,'enabled')",
    id,
    g.id,
    now(),
  );
  const jobs = () => db.must("SELECT * FROM schedule_jobs WHERE id=?", id);
  const count = () => db.all("SELECT * FROM agent_runs").length;
  db.run("UPDATE goals SET state='paused'");
  await worker.tick();
  assert.equal(count(), 1);
  db.run("UPDATE goals SET state='active'");
  db.run(
    "INSERT INTO goal_limits VALUES(?,?)",
    g.id,
    JSON.stringify({ budget: 1, cooldown: 0 }),
  );
  await worker.tick();
  assert.equal(count(), 1);
  db.run(
    "UPDATE goal_limits SET config='{\u0022budget\u0022:3,\u0022cooldown\u0022:0}'",
  );
  await worker.tick();
  assert.equal(count(), 1);
  db.run("UPDATE schedule_jobs SET lease_until=NULL");
  const j = jobs();
  await Promise.all([worker.process(j), worker.process(j)]);
  assert.equal(count(), 2);
  assert.equal(jobs().state, "disabled");
  db.run(
    "UPDATE schedule_jobs SET state='enabled',next_at=?,lease_until=NULL",
    j.next_at,
  );
  await worker.tick();
  assert.equal(count(), 2);
  db.run("UPDATE workspaces SET enabled=0");
  db.run(
    "UPDATE schedule_jobs SET next_at=?,state='enabled',attempts=2,lease_until=NULL",
    now(),
  );
  db.run(
    "UPDATE agent_runs SET status='interrupted',finished=? WHERE finished IS NULL",
    now(),
  );
  await worker.tick();
  assert.equal(jobs().attempts, 2);
  assert.equal(jobs().state, "enabled");
  const dir = db.must("SELECT path FROM workspaces WHERE id=?", g.workspace_id).path;
  renameSync(dir, dir + "-moved");
  db.run("UPDATE workspaces SET enabled=1");
  await worker.tick();
  assert.equal(jobs().attempts, 3);
  assert.equal(jobs().state, "paused");
});
test("本机同源、会话、输入校验和生成协议", async (t) => {
  const { app, token } = await setup(t);
  assert.equal(
    (
      await app.inject({
        url: "/api/v1/session",
        headers: { host: "external.example" },
      })
    ).statusCode,
    403,
  );
  for (const headers of [
    {},
    { "x-continuum-token": token, origin: "https://foreign.example" },
  ])
    assert.equal(
      (
        await app.inject({
          url: "/api/v1/goals",
          method: "POST",
          headers,
          payload: {},
        })
      ).statusCode,
      403,
    );
  assert.equal(
    (
      await app.inject({
        url: "/api/v1/goals",
        method: "POST",
        headers: { "x-continuum-token": token },
        payload: {},
      })
    ).statusCode,
    422,
  );
  const schema = readFileSync(
    "packages/codex-adapter/schema/ClientRequest.json",
    "utf8",
  );
  for (const method of [
    "initialize",
    "thread/resume",
    "thread/read",
    "turn/start",
    "turn/interrupt",
  ])
    assert.ok(schema.includes('"' + method + '"'));
});
