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

function installCodex(root: string) {
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
    if (id === 101 && !fs.existsSync("review-scenario")) {
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
    command(101);
    if (fs.existsSync("review-scenario")) {
      const masked = {command:"echo token=demo-review-fixture"};
      command(102,masked);
      command(103,{command:"re.sub(r'Bearer [^ ]+', 'hidden', line)"});
      command(104,masked);
      command(105,{...masked,additionalPermissions:{network:{enabled:true}}});
      command(106,{...masked,cwd:"/"}); command(107,{...masked,kind:"subcommand"});
      command(108,{...masked,availableDecisions:["decline"]});
      command(109,{...masked,cwd:process.cwd()+"/sub"});
    } else command(102);
  } else send({id,result:{account:{},thread:{id:"thread"}}});
});
`,
    { mode: 0o700 },
  );
}

test("本轮授权经真实审批协议逐条答复，区分普通操作、额外授权、陈旧范围和其他运行", async () => {
  const root = mkdtempSync(join(tmpdir(), "continuum-grant-"));
  const project = join(root, "project"),
    oldPath = process.env.PATH;
  mkdirSync(project);
  mkdirSync(join(project, "sub"));
  installCodex(root);
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

test("在本机查看原文后按委托授权遮盖命令，跨重启生效且原文不进入历史", async () => {
  const root = mkdtempSync(join(tmpdir(), "continuum-command-review-"));
  const project = join(root, "project"),
    oldPath = process.env.PATH;
  mkdirSync(project);
  mkdirSync(join(project, "sub"));
  installCodex(root);
  writeFileSync(join(project, "review-scenario"), "");
  process.env.PATH = root + ":" + oldPath;
  const options = { home: join(root, "db"), seed: false, worker: false };
  let api = await createServer(options);
  try {
    const workspace = api.db.workspace(project);
    const goal = () =>
      api.s.createGoal({
        title: "检查示例",
        description: "审批测试",
        workspaceId: workspace.id,
        provider: "codex",
        priority: 3,
        criteria: ["记录结果"],
        constraints: [],
      });
    const first = goal(),
      second = goal();
    const start = async (id: string) => {
      const run = await api.s.start(id, uid());
      const rows = () =>
        api.db.all(
          "SELECT * FROM inbox_items WHERE run_id=? ORDER BY request_id",
          run.id,
        );
      await until(() => rows().length === 9);
      return { run, rows: rows() };
    };
    const post = (url: string, payload: object, auth = true) =>
      api.app.inject({
        method: "POST",
        url: "/api/v1/inbox/" + url,
        headers: auth ? { "x-continuum-token": api.token } : {},
        payload,
      });
    const decide = (id: string, decision: string, reviewKey?: string) =>
      post(id + "/decision", { decision, reviewKey, key: uid(), version: 1 });
    const review = (id: string, auth = true) =>
      post(id + "/review", { version: 1 }, auth);
    const { run, rows } = await start(first.id);
    const [plain, once, source, next, ...excluded] = rows;
    assert.equal((await decide(plain.id, "approve_goal")).statusCode, 200);
    await api.worker.tick();
    assert.equal(api.s.inbox(once.id).status, "pending");
    assert.equal(once.masked_command, 1);
    assert.equal(once.allow_for_run, 0);
    assert.equal((await review(once.id, false)).statusCode, 403);
    assert.equal((await decide(once.id, "approve_goal")).statusCode, 409);
    const preview = await review(once.id);
    assert.equal(preview.headers["cache-control"], "no-store");
    const raw = preview.json().data;
    assert.equal(raw.command, "echo token=demo-review-fixture");
    assert.equal(raw.cwd, workspace.path);
    assert.equal(
      (await decide(source.id, "approve_goal", raw.reviewKey)).statusCode,
      409,
    );
    assert.equal(
      (await decide(once.id, "approve_run", raw.reviewKey)).statusCode,
      409,
    );
    assert.equal((await decide(once.id, "defer")).statusCode, 200);
    const oneTime = (reviewKey: string) =>
      post(once.id + "/decision", {
        decision: "approve",
        key: uid(),
        version: 2,
        reviewKey,
      });
    assert.equal((await oneTime(raw.reviewKey)).statusCode, 409);
    const refreshed = await post(once.id + "/review", { version: 2 });
    assert.equal(
      (await oneTime(refreshed.json().data.reviewKey)).statusCode,
      200,
    );
    assert.equal(api.s.maskedCommandGrant(first.id), null);
    assert.equal((await review(once.id)).statusCode, 409);
    const inspected = (await review(source.id)).json().data;
    assert.equal(
      (await decide(source.id, "approve_goal", inspected.reviewKey)).statusCode,
      200,
    );
    renameSync(join(project, "sub"), join(root, "moved"));
    symlinkSync(join(root, "moved"), join(project, "sub"));
    await api.worker.tick();
    assert.equal(api.s.inbox(next.id).status, "approved");
    for (const row of excluded) {
      assert.equal(api.s.inbox(row.id).status, "pending");
      assert.notEqual((await review(row.id)).statusCode, 200);
      assert.notEqual(
        (await decide(row.id, "approve_goal", inspected.reviewKey)).statusCode,
        200,
      );
    }
    const record = await api.app.inject("/api/v1/inbox/" + source.id);
    assert.ok(record.body.includes("已隐藏"));
    for (const path of [
      "/inbox",
      "/inbox/" + source.id,
      "/activity",
      "/conversation",
    ]) {
      const res = await api.app.inject("/api/v1" + path);
      assert.equal(res.statusCode, 200);
      assert.ok(
        !res.body.includes("demo-review-fixture") &&
          !res.body.includes(inspected.reviewKey),
      );
    }
    api.s.event(run.id, { key: "end", type: "run.completed", title: "完成" });
    await api.app.close();
    api = await createServer(options);
    const later = await start(first.id),
      other = await start(second.id);
    await api.worker.tick();
    assert.equal(api.s.inbox(later.rows[1].id).status, "approved");
    assert.equal(api.s.inbox(other.rows[1].id).status, "pending");
    const audit = api.db.must(
      "SELECT actor,detail FROM audit_log WHERE target=?",
      later.rows[1].id,
    );
    assert.equal(audit.actor, "goal_grant");
    assert.equal(JSON.parse(audit.detail).grant, source.id);
    api.s.revokeGoalGrant(first.id, plain.id);
    assert.equal(api.s.maskedCommandGrant(first.id), null);
    api.s.event(later.run.id, {
      key: "end",
      type: "run.completed",
      title: "完成",
    });
    const after = await start(first.id);
    await api.worker.tick();
    assert.equal(api.s.inbox(after.rows[1].id).status, "pending");
    // A newly created grant can include masked commands from its first approval.
    const request = after.rows[1].id;
    assert.equal(
      (
        await decide(
          request,
          "approve_goal",
          (await review(request)).json().data.reviewKey,
        )
      ).statusCode,
      200,
    );
    assert.equal(api.s.goalGrant(first.id), request);
    assert.equal(api.s.maskedCommandGrant(first.id), request);
  } finally {
    await api.app.close();
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
  }
});
