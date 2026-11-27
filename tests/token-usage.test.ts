import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../apps/api/src/server.ts";
import { recordChoice } from "../apps/api/src/usage.ts";
import { MainAgenda } from "../apps/api/src/main-agenda.ts";

test("临时研判、热榜和续跑分别归属；重复快照、快捷查询和重启不重复计数", async () => {
  const dir = mkdtempSync(join(tmpdir(), "continuum-meter-"));
  const home = join(dir, "data"),
    path = process.env.PATH;
  writeFileSync(
    join(dir, "codex"),
    `#!${process.execPath}
const fs = require("node:fs");
const send = p => console.log(JSON.stringify(p));
const model = (id, description, isDefault = false) => ({model:id,displayName:id,description,isDefault,
  hidden:false,inputModalities:["text"],supportedReasoningEfforts:["low","medium","high"].map(reasoningEffort=>({reasoningEffort}))});
if (process.argv.includes("exec")) {
  if (!process.argv.includes("--json") || process.argv[process.argv.indexOf("--model")+1] !== "economy" ||
      !process.argv.includes('model_reasoning_effort="low"')) process.exit(1);
  const route = !!JSON.parse(fs.readFileSync("schema.json")).properties.actions;
  fs.writeFileSync("answer.json", JSON.stringify(route ? {actions:[{type:"trending",target:"",text:"热榜",at:"",cadence:"daily",notify:"changes"}]} : {items:[]}));
  send({type:"turn.completed",usage:{input_tokens:20,output_tokens:3,cached_input_tokens:8,reasoning_output_tokens:1}});
} else {
  let resumed = false;
  require("node:readline").createInterface({input:process.stdin}).on("line", line => {
    const {method,id,params} = JSON.parse(line);
    if (id === undefined) return;
    if (method === "model/list") {
      return send({id,result:params.cursor ? {data:[model("expert","Our most capable model for complex coding")],nextCursor:null}
        : {data:[{...model("hidden","Fast affordable model"), hidden:true},model("regular","General purpose",true),model("economy","Fast and affordable")],nextCursor:"page2"}});
    }
    if (method === "thread/resume") resumed = true;
    if (method === "turn/start") {
      if (!resumed && (params.model !== "regular" || params.effort !== "medium")) return send({id,error:{message:"wrong regular selection"}});
      if (resumed && params.model === "expert" && params.effort === "high") {
        if (params.input[0].text.includes("模拟断线")) process.exit(0);
        return send({id,error:{message:"model is not available"}});
      }
      if (resumed && (params.model || params.effort)) return send({id,error:{message:"wrong fallback"}});
      const turn = {id:resumed?"two":"one",status:"completed"};
      send({method:"turn/started",params:{threadId:"thread",turn}});
      for (const [threadId,turnId,n] of [["thread",turn.id,resumed?50:30],["thread",turn.id,resumed?50:30],["thread","stale",500],["other",turn.id,500],["thread",turn.id,10]]) {
        send({method:"thread/tokenUsage/updated",params:{threadId,turnId,tokenUsage:{total:{inputTokens:n-2,outputTokens:2,totalTokens:n}}}});
      }
      send({id,result:{turn}});
      send({method:"turn/completed",params:{threadId:"thread",turn}});
    } else send({id,result:{account:{},model:"regular",reasoningEffort:"low",thread:{id:"thread"}}});
  });
}`,
    { mode: 0o700 },
  );
  process.env.PATH = dir + ":" + path;
  let api = await createServer({ home, seed: false, worker: false });
  const settings = async () =>
    (await api.app.inject("/api/v1/settings")).json().data.usage;
  const goal = async (id: string) =>
    (await api.app.inject("/api/v1/goals/" + id)).json().data.usage;
  try {
    assert.equal((await settings()).all.total, null);
    const b = { key: crypto.randomUUID(), text: "留意热榜上的工具" };
    await api.conversation.send(b);
    await api.conversation.send(b);
    await api.conversation.send({
      key: crypto.randomUUID(),
      text: "现在都怎么样了？",
    });
    const watch = api.db.must("SELECT * FROM main_tasks");
    const agenda = new MainAgenda(api.s, async () => [
      { id: "demo/app", description: "示例" },
    ]);
    agenda.tick(new Date(watch.next_at));
    await agenda.stop();
    assert.equal((await goal(watch.goal_id)).total, 23);
    const work = api.s.commission("普通工作", crypto.randomUUID());
    assert.equal((await goal(work.id)).total, null);
    for (const resumed of [false, true]) {
      const r = await api.s.start(
        work.id,
        crypto.randomUUID(),
        resumed ? "排查偶发故障" : undefined,
        resumed,
      );
      // turn/completed may arrive in a different pipe read than turn/start.
      await assertEventually(() => api.s.run(r.id).status === "succeeded");
      assert.equal((await goal(work.id)).total, resumed ? 50 : 30);
    }
    const directory = (await api.app.inject("/api/v1/models")).json().data;
    assert.deepEqual(directory.choices, {
      light: { model: "economy", effort: "low" },
      standard: { model: "regular", effort: "medium" },
      deep: { model: "expert", effort: "high" },
    });
    assert.equal(directory.models.length, 3);
    assert.deepEqual(
      directory.recent.map((c: Record<string, unknown>) => [
        c.kind,
        c.workload,
        c.model,
        c.fallback,
        c.total,
      ]),
      [
        ["委托执行", "deep", "regular", 1, 20],
        ["委托执行", "standard", "regular", 0, 30],
        ["筛选", "light", "economy", 0, 23],
        ["理解消息", "light", "economy", 0, 23],
      ],
    );
    assert.ok(
      directory.recent.every(
        (c: Record<string, unknown>) => c.finished && c.outcome === "succeeded",
      ),
    );
    await assert.rejects(
      api.s.start(work.id, crypto.randomUUID(), "排查模拟断线", true),
    );
    assert.equal(
      api.db.must("SELECT status FROM agent_runs ORDER BY rowid DESC LIMIT 1")
        .status,
      "unknown",
    );
    await api.app.close();
    api = await createServer({ home, seed: false, worker: false });
    const usage = await settings();
    assert.deepEqual(usage.conversation, { input: 20, output: 3, total: 23 });
    assert.equal(usage.goals.total, 73);
    assert.deepEqual(usage.all, { input: 88, output: 8, total: 96 });
  } finally {
    process.env.PATH = path;
    await api.app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function assertEventually(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(predicate());
}

test("委托列表取最近一轮的选模记录，同一时间按运行写入顺序区分", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "continuum-list-model-"));
  const { s, db, app } = await createServer({
    home,
    worker: false,
    seed: false,
  });
  t.after(async () => {
    await app.close();
    rmSync(home, { recursive: true, force: true });
  });
  const goal = s.commission("列表测试", crypto.randomUUID());
  const selection = async () => {
    const res = await app.inject("/api/v1/goals");
    assert.equal(res.statusCode, 200, res.body);
    const [{ latest, latestModel, latestEffort }] = res.json().data;
    return [latest, latestModel, latestEffort];
  };
  assert.deepEqual(await selection(), [null, null, null]);
  const first = s.reserve(goal, crypto.randomUUID(), "第一轮", null);
  recordChoice(db, first.id, "委托执行", "light", {
    model: "sample-fast",
    effort: "low",
  });
  s.move(first, "failed");
  assert.deepEqual(await selection(), ["failed", "sample-fast", "low"]);
  const second = s.reserve(goal, crypto.randomUUID(), "第二轮", null);
  db.run(
    "UPDATE agent_runs SET created=? WHERE id=?",
    first.created,
    second.id,
  );
  assert.deepEqual(await selection(), ["starting", null, null]);
  recordChoice(db, second.id, "委托执行", "deep", {
    model: "sample-deep",
    effort: "high",
  });
  assert.deepEqual(await selection(), ["starting", "sample-deep", "high"]);
});
