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
    await conv.send({ key: key(), text: "怎么样了？", focus: g.id });
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
