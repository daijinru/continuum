import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../apps/api/src/server.ts";
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
if (process.argv.includes("exec")) {
  if (!process.argv.includes("--json")) process.exit(1);
  const route = !!JSON.parse(fs.readFileSync("schema.json")).properties.actions;
  fs.writeFileSync("answer.json", JSON.stringify(route ? {actions:[{type:"trending",target:"",text:"热榜",at:"",cadence:"daily",notify:"changes"}]} : {items:[]}));
  send({type:"turn.completed",usage:{input_tokens:20,output_tokens:3,cached_input_tokens:8,reasoning_output_tokens:1}});
} else {
  let resumed = false;
  require("node:readline").createInterface({input:process.stdin}).on("line", line => {
    const {method,id} = JSON.parse(line);
    if (id === undefined) return;
    if (method === "thread/resume") resumed = true;
    if (method === "turn/start") {
      const turn = {id:resumed?"two":"one",status:"completed"};
      send({method:"turn/started",params:{threadId:"thread",turn}});
      for (const [threadId,turnId,n] of [["thread",turn.id,resumed?50:30],["thread",turn.id,resumed?50:30],["thread","stale",500],["other",turn.id,500],["thread",turn.id,10]]) {
        send({method:"thread/tokenUsage/updated",params:{threadId,turnId,tokenUsage:{total:{inputTokens:n-2,outputTokens:2,totalTokens:n}}}});
      }
      send({id,result:{turn}});
      send({method:"turn/completed",params:{threadId:"thread",turn}});
    } else send({id,result:{account:{},thread:{id:"thread"}}});
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
        undefined,
        resumed,
      );
      // turn/completed may arrive in a different pipe read than turn/start.
      await assertEventually(() => api.s.run(r.id).status === "succeeded");
      assert.equal((await goal(work.id)).total, resumed ? 50 : 30);
    }
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
