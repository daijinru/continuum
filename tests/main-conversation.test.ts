import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../apps/api/src/server.ts";
import { MainAgenda, trendingRepos } from "../apps/api/src/main-agenda.ts";
import {
  MainConversation,
  timeline,
} from "../apps/api/src/main-conversation.ts";
import type { Intent } from "../apps/api/src/main-model.ts";
import { acknowledge, generate } from "../packages/briefing/src/index.ts";
const intent = (
  type: Intent["type"],
  text: string,
  more: Partial<Intent> = {},
): Intent => ({
  type,
  text,
  target: "",
  at: "",
  notify: "always",
  cadence: "once",
  ...more,
});
const key = () => crypto.randomUUID();
const after = (at: string) => new Date(new Date(at).getTime() + 1000);
const fixture = () => mkdtempSync(join(tmpdir(), "continuum-main-"));

test("日志查看器按写入顺序只读取最近一百条", async (t) => {
  const { app, db } = await createServer({ home: fixture(), worker: false, seed: false });
  t.after(() => app.close());
  const read = async () => (await app.inject("/api/v1/conversation/log")).json().data;
  assert.deepEqual(await read(), []);
  db.tx(() => {
    for (let i = 0; i < 101; i++) db.run("INSERT INTO conversation_log(stage) VALUES('received')");
  });
  const rows = await read();
  assert.deepEqual(rows.map((row: { seq: number }) => row.seq), Array.from({ length: 100 }, (_, i) => 101 - i));
  assert.equal(rows[0].client_at, null);
  assert.deepEqual(await read(), rows);
});

test("一个主对话：复合承诺、幂等提交、静默、单项回复、确定性提醒与重启恢复", async () => {
  const home = fixture(),
    api = await createServer({ home, worker: false, seed: false });
  let current = api;
  try {
    const { db, s } = api;
    const conversation = new MainConversation(s, async () => [
      intent("trending", "留意新工具", {
        at: "2099-03-20T09:00",
        cadence: "daily",
        notify: "changes",
      }),
      intent("reminder", "准备周会", { at: "2099-03-21T10:00" }),
    ]);
    const input = { key: key(), text: "留意新工具，另在周五提醒开会。" };
    await conversation.send(input);
    await conversation.send(input);
    const ack = timeline(db).at(-1)!;
    assert.equal(ack.refs.length, 2);
    assert.equal(db.all("select id from goals").length, 2);
    const watch = db.must("SELECT * FROM main_tasks WHERE mode='trending'"),
      rem = db.must("SELECT * FROM main_tasks WHERE mode='reminder'");
    await conversation.send({ key: key(), text: "现在都怎么样了？" });
    assert.equal(timeline(db).at(-1)!.refs.length, 2);
    assert.equal(db.all("SELECT * FROM user_messages").length, 0);
    await conversation.send({ key: key(), text: "先停一下" });
    assert.equal(timeline(db).at(-1)!.kind, "question");
    assert.ok(
      db.all("select state from goals").every((g) => g.state === "active"),
    );
    const agenda = new MainAgenda(
      s,
      async () => [
        { id: "one/app", description: "offline tool" },
        { id: "two/app", description: "other tool" },
      ],
      async (_req, items) => [{ id: items[0].id, reason: "可离线使用" }],
    );
    agenda.tick(after(watch.next_at));
    await agenda.stop();
    const report = timeline(db).at(-1)!;
    assert.match(report.body, /one\/app/);
    conversation.route = async (ctx) => {
      assert.deepEqual(ctx.replyTargets, [watch.goal_id]);
      return [
        intent("preference", "以后关注本地工具", { target: watch.goal_id }),
      ];
    };
    await conversation.send({
      key: key(),
      text: "以后关注本地工具",
      replyTo: report.id,
    });
    assert.match(s.goal(watch.goal_id).constraints_json, /本地工具/);
    assert.equal(s.goal(rem.goal_id).constraints_json, "[]");
    // A changed preference may surface a previously unreported repo. Without
    // another change, re-checking the same source must not produce more messages.
    const second = db.must(
      "select next_at from main_tasks where goal_id=?",
      watch.goal_id,
    ).next_at;
    agenda.tick(after(second));
    await agenda.stop();
    await api.app.close();
    current = await createServer({ home, worker: false, seed: false });
    const recovered = new MainAgenda(
      current.s,
      async () => [
        { id: "one/app", description: "offline tool" },
        { id: "two/app", description: "other tool" },
      ],
      async () => {
        throw Error("未变化不应唤醒模型");
      },
    );
    recovered.tick(after(rem.next_at));
    await recovered.stop();
    const next = current.db.must(
      "select next_at from main_tasks where goal_id=?",
      watch.goal_id,
    ).next_at;
    recovered.tick(after(next));
    await recovered.stop();
    const messages = timeline(current.db);
    const savedReply = messages.find(m => m.role === "user" && m.reply_to === report.id)!;
    assert.deepEqual(savedReply.quote, {
      type: "message", id: report.id, text: report.body.slice(0, 240),
      kind: report.kind, role: report.role, origin: report.origin, created: report.created,
    });
    assert.equal(messages.find(m => m.id === input.key)!.quote, null);
    assert.equal(messages.filter((m) => m.kind === "reminder").length, 1);
    assert.equal(messages.filter((m) => m.kind === "result").length, 2);
    assert.equal(current.db.all("SELECT * FROM main_observations").length, 3);
    assert.equal(current.db.all("SELECT * FROM agent_runs").length, 0);
    const snapshot = generate(current.db);
    assert.equal(snapshot.native.length, 3);
    acknowledge(current.db, snapshot.id);
    assert.equal(generate(current.db).native.length, 0);
    assert.equal(current.s.goal(rem.goal_id).state, "completed");
  } finally {
    await current.app.close();
  }
});

test("来源失败不是没有变化；持续失败只提示一次，进度查询不唤醒执行", async () => {
  const api = await createServer({
    home: fixture(),
    worker: false,
    seed: false,
  });
  try {
    const { db, s } = api;
    const conv = new MainConversation(s, async () => [
      intent("trending", "关注热榜", { notify: "changes", cadence: "daily" }),
    ]);
    await conv.send({ key: key(), text: "关注热榜" });
    const g = db.must("select id from goals");
    const agenda = new MainAgenda(
      s,
      async () => {
        throw Error("连接失败");
      },
      async () => [],
    );
    for (let i = 0; i < 4; i++) {
      agenda.tick(after(db.must("select next_at from main_tasks").next_at));
      await agenda.stop();
    }
    assert.equal(timeline(db).filter((m) => m.kind === "problem").length, 1);
    assert.equal(db.all("select * from main_observations").length, 0);
    const focused = { key: key(), text: "怎么样了？", focus: g.id };
    await conv.send(focused);
    const snapshot = await api.app.inject("/api/v1/conversation");
    const quote = snapshot.json().data.find((m: { id: string }) => m.id === focused.key).quote;
    assert.deepEqual(quote, { type: "goal", id: g.id, text: s.goal(g.id).title });
    db.run("UPDATE goals SET title=? WHERE id=?", "工具周报", g.id);
    const changes = await api.app.inject("/api/v1/conversation/changes?since=" + snapshot.headers["x-conversation-version"]);
    assert.equal(changes.json().data.rows.find((m: { id: string }) => m.id === focused.key).quote.text, "工具周报");
    assert.match(timeline(db).at(-1)!.body, /没有|尚无成功读取/);
    assert.equal(db.all("select * from agent_runs").length, 0);
  } finally {
    await api.app.close();
  }
});

test("解析真实榜单结构，过滤非仓库链接，拒绝空页面", () => {
  assert.deepEqual(
    trendingRepos(
      '<article class="Box-row"><h2><a href="/team/tool">tool</a></h2><p>A &amp; B</p></article>',
    ),
    [{ id: "team/tool", description: "A & B" }],
  );
  assert.throws(() => trendingRepos("<h1>Oops</h1>"));
});

test("在途观察遇到暂停：不投递旧结果，也不推进成功游标", async () => {
  const api = await createServer({
    home: fixture(),
    worker: false,
    seed: false,
  });
  try {
    const c = new MainConversation(api.s, async () => [
      intent("trending", "关注热榜", { cadence: "daily", notify: "changes" }),
    ]);
    await c.send({ text: "关注热榜", key: key() });
    const t = api.db.must("SELECT * FROM main_tasks");
    let finish!: (rows: { id: string; description: string }[]) => void;
    const slow = new MainAgenda(
      api.s,
      () =>
        new Promise((ok) => {
          finish = ok;
        }),
      async () => [{ id: "team/app", reason: "符合偏好" }],
    );
    slow.tick(after(t.next_at));
    c.route = async () => [intent("pause", "暂停关注", { target: t.goal_id })];
    await c.send({ text: "暂停热榜关注", key: key() });
    finish([{ id: "team/app", description: "一个工具" }]);
    await slow.stop();
    assert.equal(api.s.goal(t.goal_id).state, "paused");
    assert.equal(
      api.db.must("select succeeded from main_tasks").succeeded,
      null,
    );
    assert.equal(timeline(api.db).filter((m) => m.kind === "result").length, 0);
  } finally {
    await api.app.close();
  }
});

test("每项工作单独关联项目，待确认项跨重启恢复且只接单一次", async () => {
  const home = fixture();
  let api = await createServer({ home, worker: false, seed: false });
  try {
    const project = api.db.workspace(fixture(), "计划室");
    const c = new MainConversation(api.s, async () => [
      intent("work", "修复计划室导出", { project: "计划室" }),
      intent("work", "写旅行清单", { project: "" }),
      intent("work", "更新画册的说明", { project: "画册" }),
    ]);
    const msg = {
      key: key(),
      text: "修复计划室导出，写旅行清单，再更新画册的说明",
    };
    await c.send(msg);
    await c.send(msg);
    const rows = api.db.all("SELECT * FROM goals ORDER BY rowid");
    assert.equal(rows.length, 2);
    assert.equal(rows[0].workspace_id, project.id);
    assert.notEqual(rows[1].workspace_id, project.id);
    assert.deepEqual(
      api.db.projects().map((p) => p.id),
      [project.id],
    );
    const question = timeline(api.db).find((m) => m.kind === "project")!;
    assert.equal(question.project, "画册");
    await api.app.close();
    api = await createServer({ home, worker: false, seed: false });
    const payload = { kind: "authorize", path: fixture(), name: "画册" };
    const submit = (body: object) =>
      api.app.inject({
        method: "POST",
        url: "/api/v1/conversation/projects/" + question.id,
        headers: { "x-continuum-token": api.token },
        payload: body,
      });
    const responses = await Promise.all([submit(payload), submit(payload)]);
    assert.ok(responses.every((r) => r.statusCode === 200));
    assert.equal(responses[0].json().data.id, responses[1].json().data.id);
    assert.equal((await submit({ kind: "cancel" })).statusCode, 409);
    const settings = (await api.app.inject("/api/v1/settings")).json().data;
    assert.equal(settings.workspaces.length, 2);
    assert.equal(
      settings.workspaces.find((p: { name: string }) => p.name === "画册")
        .affected,
      1,
    );
    assert.equal(api.db.all("SELECT id FROM user_messages").length, 3);
    assert.equal(
      timeline(api.db).find((m) => m.id === msg.key)!.refs.length,
      3,
    );
    assert.ok(timeline(api.db).find((m) => m.id === question.id)!.resolvedBy);
  } finally {
    await api.app.close();
  }
});

test("同名项目先确认，停用须明确重新授权；单独回复项目名称可以继续", async () => {
  const api = await createServer({
    home: fixture(),
    worker: false,
    seed: false,
  });
  try {
    const { db, s } = api;
    const p = db.workspace(fixture(), "计划室");
    db.workspace(fixture(), "计划室");
    const other = db.workspace(fixture(), "资料库");
    const c = new MainConversation(s, async () => [
      intent("work", "修计划室导出", { project: "计划室" }),
    ]);
    await c.send({ key: key(), text: "修计划室导出" });
    const first = timeline(db).at(-1)!;
    assert.equal(first.kind, "project");
    db.run("UPDATE workspaces SET enabled=0 WHERE id=?", p.id);
    assert.throws(
      () => c.resolveProject(first.id, { kind: "select", workspaceId: p.id }),
      /停用/,
    );
    assert.equal(db.all("SELECT id FROM goals").length, 0);
    c.resolveProject(first.id, {
      kind: "select",
      workspaceId: p.id,
      enable: true,
    });
    assert.equal(db.must("SELECT workspace_id FROM goals").workspace_id, p.id);
    c.route = async () => [intent("work", "更新导出", { project: "?" })];
    await c.send({ key: key(), text: "更新导出" });
    const answer = { key: key(), text: "资料库" };
    await c.send(answer);
    await c.send(answer);
    assert.equal(
      db.must("SELECT workspace_id FROM goals WHERE title='更新导出'")
        .workspace_id,
      other.id,
    );
    assert.equal(db.all("SELECT id FROM user_messages").length, 2);
  } finally {
    await api.app.close();
  }
});

test("断线后的消息按变化顺序补齐，多批回放和事务回滚均不丢失游标", async (t) => {
  const { app, db } = await createServer({ home: fixture(), worker: false, seed: false });
  t.after(() => app.close());
  const snapshot = await app.inject("/api/v1/conversation");
  let version = Number(snapshot.headers["x-conversation-version"]);
  assert.equal(version, 0);
  const ids = Array.from({ length: 167 }, key);
  const insert = (id: string) => db.run(
    "INSERT INTO main_messages(id,role,kind,body,created) VALUES(?,'assistant','reminder','提醒',?)",
    id, new Date().toISOString(),
  );
  db.tx(() => ids.forEach(insert));
  const received: string[] = [];
  for (const more of [true, true, false]) {
    const { rows, version: next, more: remaining }: { rows: { id: string }[]; version: number; more: boolean } =
      (await app.inject("/api/v1/conversation/changes?since=" + version)).json().data;
    assert.equal(remaining, more);
    assert.ok(next > version);
    received.push(...rows.map(r => r.id));
    version = next;
  }
  assert.deepEqual(received, ids);
  assert.throws(() => db.tx(() => { insert(key()); throw Error("rollback"); }));
  const result = await app.inject("/api/v1/conversation/changes?since=" + version);
  assert.deepEqual(result.json().data, { rows: [], version, more: false });
});

test("每项工作单独保存难度，排期沿用原判断，重新交代只改变这一轮", async (t) => {
  const api = await createServer({ home: fixture(), worker: false, seed: false });
  t.after(() => api.app.close());
  const { s, db, agenda } = api;
  const conversation = new MainConversation(s, async () => [
    intent("work", "整理已有材料", { workload: "light" }),
    intent("work", "核对两个系统的数据", { at: "2099-03-20T09:00", workload: "deep" }),
  ]);
  await conversation.send({ key: key(), text: "整理材料，另外预约数据核对" });
  const scheduled = db.must("SELECT * FROM main_tasks WHERE next_at IS NOT NULL");
  agenda.tick(after(scheduled.next_at));
  await agenda.stop();
  assert.equal(db.must("SELECT workload FROM user_messages WHERE goal_id=?", scheduled.goal_id).workload, "deep");
  const first = db.must("SELECT * FROM user_messages WHERE workload='light'");
  conversation.route = async () => [intent("rerun", "对照多个版本找出差异原因", { workload: "deep", target: first.goal_id })];
  await conversation.send({ key: key(), text: "再核对一次差异原因" });
  assert.deepEqual(db.all("SELECT workload FROM user_messages WHERE goal_id=? ORDER BY rowid", first.goal_id).map(m => m.workload), ["light", "deep"]);
});
