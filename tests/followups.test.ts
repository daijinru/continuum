import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "../apps/api/src/server.ts";
import { timeline } from "../apps/api/src/main-conversation.ts";
import { uid } from "../apps/api/src/db.ts";
import type { Context } from "../packages/agent-core/src/index.ts";
import type { Intent } from "../apps/api/src/main-model.ts";
import { reports } from "../packages/briefing/src/index.ts";

const question = "请提供截图，或提供工号和大致发生时间。";
const intent = (type: Intent["type"], target: string, text = ""): Intent[] => [
  { type, target, text, notify: "always", cadence: "once", at: "" },
];

async function fixture(marked: boolean) {
  const home = mkdtempSync(join(tmpdir(), "continuum-followup-"));
  const api = await createServer({ home, seed: false, worker: false });
  const goal = api.s.commission("排查合成样例", uid());
  const body = "上次观察。".repeat(120) + question;
  api.s.adapters.codex.start = async (ctx) => {
    ctx.reference("test-thread", "one");
    ctx.emit({ key: "start", type: "run.started", title: "开始" });
    ctx.emit({
      key: "ask",
      type: "agent.message",
      title: body,
      data: marked ? { followup: question } : {},
    });
    ctx.emit({ key: "end", type: "run.completed", title: "结束" });
  };
  await api.worker.tick();
  return { api, home, goal, original: timeline(api.db).at(-1)! };
}

test("分步补资料、问进度、重启和重复提交；只带原话续跑原线程一次", async (t) => {
  const { api, home, goal, original } = await fixture(true);
  let current = api;
  t.after(() => current.app.close());
  assert.equal(original.kind, "question");
  assert.equal(reports(api.db, 0, Number.MAX_SAFE_INTEGER).length, 0);
  const queued = () =>
    current.db.all("SELECT * FROM user_messages WHERE status='queued'");
  const send = async (text: string, replyTo?: string, key = uid()) => {
    const res = await current.app.inject({
      method: "POST",
      url: "/api/v1/conversation/messages",
      headers: { "x-continuum-token": current.token },
      payload: { key, text, replyTo },
    });
    assert.equal(res.statusCode, 200, res.body);
    return timeline(current.db).at(-1)!;
  };

  api.conversation.route = async (input) => {
    assert.equal((input.followup as { question: string }).question, question);
    return intent("supply_partial", goal.id, "大概是什么时间？");
  };
  const partial = await send("工号 TEST-17", original.id);
  assert.equal(partial.kind, "question");
  assert.deepEqual(
    partial.refs.map((r: { id: string }) => r.id),
    [goal.id],
  );
  assert.match(
    (await send("进度怎样了", partial.id)).body,
    /TEST-17.*大概是什么时间/,
  );
  assert.equal(queued().length, 0);
  await api.app.close();
  current = await createServer({ home, seed: false, worker: false });
  current.conversation.route = async (input) => {
    const f = input.followup as {
      answers: { answer: string }[];
      question: string;
    };
    assert.equal(f.answers[0].answer, "工号 TEST-17");
    assert.equal(f.question, partial.body);
    return intent("supply", goal.id);
  };
  const key = uid();
  const ack = await send("昨天上午十点", undefined, key);
  assert.match(ack.body, /排队/);
  await send("昨天上午十点", undefined, key);
  assert.equal(queued().length, 1);
  assert.match((await send("进度怎样了", ack.id)).body, /排队/);
  const starts: Context[] = [];
  current.s.adapters.codex.start = async (ctx) => {
    starts.push(ctx);
    ctx.emit({ key: "start", type: "run.started", title: "开始" });
    ctx.emit({ key: "answer", type: "agent.message", title: "找到了结果。" });
    ctx.emit({ key: "end", type: "run.completed", title: "结束" });
  };
  await current.worker.tick();
  await current.worker.tick();
  assert.equal(starts.length, 1);
  assert.equal(starts[0].thread, "test-thread");
  assert.match(starts[0].instruction, /工号 TEST-17/);
  assert.match(starts[0].instruction, /昨天上午十点/);
  const result = timeline(current.db).at(-1)!;
  current.conversation.route = async () => intent("talk", "", "不客气。");
  await send("谢谢", result.id);
  assert.equal(queued().length, 0);

  current.conversation.route = async () => intent("supply", goal.id);
  assert.match((await send("昨天上午十点", partial.id)).body, /不能继续/);
  assert.equal(queued().length, 0);
});

test("旧结果中超过 400 字的提问仍可回复；错绑或判读期间暂停不会派工", async (t) => {
  const { api, goal, original } = await fixture(false);
  t.after(() => api.app.close());
  assert.equal(original.kind, "result");
  const input = { text: "工号 TEST-12，周五上午。", replyTo: original.id };
  api.conversation.route = async (context) => {
    assert.match(String(context.replyText), /工号和大致发生时间/);
    return intent("supply", uid());
  };
  await assert.rejects(api.conversation.send({ ...input, key: uid() }), /关联/);
  api.conversation.route = async () => {
    api.db.run("UPDATE goals SET state='paused' WHERE id=?", goal.id);
    return intent("supply", goal.id);
  };
  await api.conversation.send({ ...input, key: uid() });
  assert.equal(
    api.db.all("SELECT id FROM user_messages WHERE status='queued'").length,
    0,
  );
  api.db.run("UPDATE goals SET state='active' WHERE id=?", goal.id);
  api.conversation.route = async () => intent("supply", goal.id);
  await api.conversation.send({ ...input, key: uid() });
  assert.equal(
    api.db.must("SELECT goal_id FROM user_messages WHERE status='queued'")
      .goal_id,
    goal.id,
  );
});
