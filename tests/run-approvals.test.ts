import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "../apps/api/src/server.ts";
import { uid } from "../apps/api/src/db.ts";

async function until(ready: () => boolean) {
  const end = Date.now() + 5000;
  while (!ready() && Date.now() < end) await delay(10);
  assert.ok(ready());
}

test("本轮授权经真实审批协议逐条答复，区分普通操作、额外授权、陈旧范围和其他运行", async () => {
  const root = mkdtempSync(join(tmpdir(), "continuum-grant-"));
  const project = join(root, "project"),
    oldPath = process.env.PATH;
  mkdirSync(project);
  mkdirSync(join(project, "sub"));
  writeFileSync(
    join(root, "codex"),
    `#!${process.execPath}
const fs = require("node:fs");
const send = p => console.log(JSON.stringify(p));
const base = {threadId:"thread", turnId:"turn"};
const command = (id, extras = {}) => send({id,method:"item/commandExecution/requestApproval",params:{...base,itemId:"c"+id,command:"pwd",cwd:process.cwd(),...extras}});
const file = (id, path) => {
  const item = {type:"fileChange",id:"f"+id,changes:[{path,kind:{type:"add"},diff:"+hi"}]};
  send({method:"item/started",params:{...base,item}});
  send({id,method:"item/fileChange/requestApproval",params:{...base,itemId:item.id}});
};
require("node:readline").createInterface({input:process.stdin}).on("line", line => {
  const {method,id,result} = JSON.parse(line);
  if (id === undefined) return;
  if (!method) {
    fs.appendFileSync("responses",id+" "+result.decision+"\\n");
    if (id === 101) {
      command(103,{command:"ls"});
      file(104,"notes.txt");
      file(105,"sub/moved.txt");
      command(106,{additionalPermissions:{network:{enabled:true}}});
      command(107,{cwd:"/"});
      send({id:108,method:"item/tool/requestUserInput",params:{...base,questions:[{id:"q",header:"格式",question:"哪种格式？"}]}});
    }
  } else if (method === "turn/start") {
    const turn={id:"turn",status:"inProgress"};
    send({method:"turn/started",params:{threadId:"thread",turn}});
    send({id,result:{turn}});
    command(101); command(102);
  } else send({id,result:{account:{},thread:{id:"thread"}}});
});
`,
    { mode: 0o700 },
  );
  process.env.PATH = root + ":" + oldPath;
  const { app, s, db, token, worker } = await createServer({
    home: join(root, "db"),
    seed: false,
    worker: false,
  });
  const decide = (id: string, decision: string, key = uid()) =>
    app.inject({
      method: "POST",
      url: "/api/v1/inbox/" + id + "/decision",
      headers: { "x-continuum-token": token },
      payload: { decision, key, version: 1 },
    });
  try {
    const w = db.workspace(project);
    const make = () =>
      s.createGoal({
        title: "整理资料",
        description: "协议测试",
        workspaceId: w.id,
        provider: "codex",
        priority: 3,
        criteria: ["记录实际答复"],
        constraints: [],
      });
    const goal = make();
    const r = await s.start(goal.id, uid());
    const row = (id: number, run = r.id) =>
      db.must(
        "SELECT * FROM inbox_items WHERE run_id=? AND request_id=?",
        run,
        String(id),
      );
    const count = (run: string) =>
      db.must("SELECT count(*) n FROM inbox_items WHERE run_id=?", run).n;
    await until(() => count(r.id) === 2);
    assert.equal(row(101).allow_for_run, 1);
    const key = uid(),
      first = row(101).id;
    assert.equal((await decide(first, "approve_run", key)).statusCode, 200);
    assert.equal((await decide(first, "approve_run", key)).statusCode, 200);
    assert.equal((await decide(first, "approve", key)).statusCode, 409);
    await until(() => count(r.id) === 8);
    const other = await s.start(make().id, uid());
    await until(() => count(other.id) === 2);
    renameSync(join(project, "sub"), join(root, "moved"));
    symlinkSync(join(root, "moved"), join(project, "sub"));
    db.run("UPDATE workspaces SET enabled=0 WHERE id=?", w.id);
    await worker.tick();
    assert.equal(row(102).status, "pending");
    db.run("UPDATE workspaces SET enabled=1 WHERE id=?", w.id);
    await worker.tick();
    await worker.tick();
    const responses = () =>
      readFileSync(join(project, "responses"), "utf8").trim().split("\n");
    await until(() => responses().length === 4);
    assert.deepEqual(responses(), [
      "101 accept",
      "102 accept",
      "103 accept",
      "104 accept",
    ]);
    for (const id of [102, 103, 104]) {
      const audit = db.must(
        "SELECT * FROM audit_log WHERE target=?",
        row(id).id,
      );
      assert.equal(row(id).status, "approved");
      assert.equal(audit.actor, "run_grant");
      assert.equal(JSON.parse(audit.detail).grant, first);
    }
    for (const id of [105, 106, 107, 108]) {
      assert.equal(row(id).status, "pending");
      assert.equal(row(id).allow_for_run, 0);
      assert.notEqual(
        (await decide(row(id).id, "approve_run")).statusCode,
        200,
      );
      assert.notEqual(
        (await decide(row(id).id, "approve_goal")).statusCode,
        200,
      );
    }
    assert.equal(row(101, other.id).status, "pending");
    assert.equal(row(102, other.id).status, "pending");
    assert.equal(
      (await decide(row(101, other.id).id, "approve")).statusCode,
      200,
    );
    await until(() => count(other.id) === 8);
    await worker.tick();
    assert.equal(row(103, other.id).status, "pending");
    s.event(r.id, { key: "done", type: "run.completed", title: "完成" });
    const next = await s.start(goal.id, uid(), undefined, true);
    await until(() => count(next.id) === 2);
    await worker.tick();
    assert.equal(row(101, next.id).status, "pending");
    assert.equal(row(102, next.id).status, "pending");
  } finally {
    await app.close();
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
  }
});
