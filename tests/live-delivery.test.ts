import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "../apps/api/src/server.ts";
import { timeline } from "../apps/api/src/main-conversation.ts";
import type { Context } from "../packages/agent-core/src/index.ts";
import { uid } from "../apps/api/src/db.ts";

test("另一委托执行时独立投递即时消息，普通说明保持安静，终态和重放不重复投递", async (t) => {
  const { app, db, s, worker } = await createServer({
    home: mkdtempSync(join(tmpdir(), "continuum-delivery-")),
    worker: false,
    seed: false,
  });
  t.after(() => app.close());
  const runs: Context[] = [];
  s.adapters.codex.start = async (c) => {
    runs.push(c);
    c.emit({ key: "start", type: "run.started", title: "开始" });
  };
  const first = s.commission("较长工作", uid());
  s.commission("较短工作", uid());
  await worker.tick();
  const [long, short] = runs;
  const bodies = () => timeline(db).map((r) => r.body);
  const note = {
    key: "update",
    type: "agent.message",
    title: "第一份样稿可以查看",
    data: { delivery: "async" },
  };
  long.emit({ key: "step", type: "agent.message", title: "正在处理样稿" });
  long.emit(note);
  long.emit(note);
  assert.deepEqual(bodies(), [note.title]);
  short.emit({ key: "final", type: "agent.message", title: "第二项最终结果" });
  short.emit({ key: "end", type: "run.completed", title: "结束" });
  assert.deepEqual(bodies(), [note.title, "第二项最终结果"]);
  assert.equal(s.run(long.id).status, "running");
  db.run("UPDATE goals SET state='paused' WHERE id=?", first.id);
  long.emit({ ...note, key: "paused", title: "暂停后产生的更新" });
  db.run("UPDATE goals SET state='active' WHERE id=?", first.id);
  long.emit({ ...note, key: "new", title: "第二份样稿可以查看" });
  long.emit({ key: "end", type: "run.completed", title: "结束" });
  long.emit({ ...note, key: "late", title: "结束后迟到的更新" });
  assert.deepEqual(bodies(), [
    note.title,
    "第二项最终结果",
    "第二份样稿可以查看",
  ]);
});

test("协议的异步标记和问题选项抵达主对话；回复归属本轮，不依赖结束通知", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "continuum-live-cli-"));
  writeFileSync(
    join(dir, "codex"),
    `#!${process.execPath}
const send = packet => console.log(JSON.stringify(packet));
require("node:readline").createInterface({input:process.stdin}).on("line", line => {
  const {id,method} = JSON.parse(line);
  if(id === undefined) return;
  const threadId = "sample-thread", turnId = "sample-turn";
  if(method === "turn/start"){
    const turn = { id:turnId,status:"inProgress" };
    send({method:"turn/started",params:{threadId,turn}});
    const item = {id:"sample-question",type:"agentMessage",text:"可选样式已就绪",phase:"commentary",delivery:"async",questions:[{title:"选什么样式？",options:["简洁","详细"]}]};
    send({method:"item/completed",params:{threadId,turnId,item}});
    send({id,result:{turn}});
  } else send({id,result:{account:{},thread:{id:threadId}}});
});
`,
    { mode: 0o700 },
  );
  const path = process.env.PATH;
  process.env.PATH = dir + ":" + path;
  t.after(() => {
    process.env.PATH = path;
  });
  const { s, db, worker, app, conversation } = await createServer({
    home: join(dir, "data"),
    seed: false,
    worker: false,
  });
  t.after(() => app.close());
  const goal = s.commission("合成报告", uid());
  await worker.tick();
  const message = timeline(db).at(-1)!;
  assert.equal(message.kind, "question");
  assert.match(message.body, /可选样式已就绪.*选什么样式.*简洁.*详细/s);
  const run = db.must("SELECT * FROM agent_runs");
  assert.equal(run.status, "running");
  conversation.route = async (input) => {
    assert.equal((input.followup as { run: string }).run, run.id);
    return [
      {
        type: "supply",
        target: goal.id,
        text: "简洁",
        at: "",
        cadence: "once",
        notify: "always",
      },
    ];
  };
  await conversation.send({ key: uid(), replyTo: message.id, text: "简洁" });
  assert.equal(
    db.must("SELECT source_run FROM user_messages WHERE status='queued'")
      .source_run,
    run.id,
  );
  await worker.tick();
  assert.equal(db.must("SELECT count(*) n FROM agent_runs").n, 1);
});
