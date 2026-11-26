import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uid, now } from "../apps/api/src/db.ts";
import { createServer } from "../apps/api/src/server.ts";

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "continuum-goal-grant-"));
  const home = join(root, "store"),
    project = join(root, "project");
  mkdirSync(project);
  const replies: string[] = [];
  const open = async () => {
    const api = await createServer({ home, seed: false, worker: false });
    api.s.adapters.codex.start = async (c) => {
      c.emit({ type: "run.started", key: "start", title: "执行中" });
    };
    api.s.adapters.codex.respond = async (_run, id) => {
      replies.push(id);
    };
    return api;
  };
  let api = await open();
  const w = api.db.workspace(project);
  t.after(async () => {
    await api.app.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    get api() {
      return api;
    },
    w,
    replies,
    async restart() {
      await api.app.close();
      api = await open();
    },
    goal() {
      return api.s.createGoal({
        title: "整理资料",
        description: "按期整理",
        provider: "codex",
        priority: 3,
        workspaceId: w.id,
        criteria: ["保存结果"],
        constraints: [],
      });
    },
    request(run: string, label: string, regular = true) {
      api.s.event(run, {
        key: label,
        type: "approval.requested",
        title: label,
        approval: {
          id: label,
          action: label,
          scope: w.path,
          reason: "需要批准",
          risk: "需审查",
          allowForRun: regular,
        },
      });
      return api.db.must(
        "SELECT * FROM inbox_items WHERE run_id=? AND request_id=?",
        run,
        label,
      );
    },
    post(path: string, payload: object, method: "PATCH" | "POST" = "POST") {
      return api.app.inject({
        method,
        url: "/api/v1" + path,
        headers: { "x-continuum-token": api.token },
        payload,
      });
    },
  };
}

test("委托授权跨重启沿用于定时执行，区分同项目的其他委托、额外权限和撤销", async (t) => {
  const f = await fixture(t),
    goal = f.goal(),
    other = f.goal(),
    path = "/goals/" + goal.id;
  const first = await f.api.s.start(goal.id, uid());
  const source = f.request(first.id, "首次请求").id;
  const decision = { decision: "approve_goal", version: 1, key: uid() };
  const endpoint = "/inbox/" + source + "/decision";
  assert.equal((await f.post(endpoint, decision)).statusCode, 200);
  assert.equal((await f.post(endpoint, decision)).statusCode, 200);
  f.api.s.event(first.id, {
    key: "done",
    type: "run.completed",
    title: "第一轮完成",
  });
  await f.restart();
  assert.equal(
    (await f.api.app.inject("/api/v1" + path)).json().data.approvalGrant,
    source,
  );
  await f.post(path + "/limits", { cooldown: 0 }, "PATCH");
  assert.equal(
    (
      await f.post(path + "/schedules", {
        kind: "one_off",
        instruction: "执行第二轮",
        minutes: 1,
        nextAt: now(),
      })
    ).statusCode,
    200,
  );
  await f.api.worker.tick();
  const scheduled = f.api.db.must(
    "SELECT id FROM agent_runs WHERE goal_id=? AND key LIKE 'job:%'",
    goal.id,
  );
  const regular = f.request(scheduled.id, "下一轮常规操作");
  const extra = f.request(scheduled.id, "额外权限", false);
  const unrelated = f.request(
    (await f.api.s.start(other.id, uid())).id,
    "同目录的另一项委托",
  );
  await f.api.worker.tick();
  await f.api.worker.tick();
  assert.deepEqual(f.replies, ["首次请求", "下一轮常规操作"]);
  const audit = f.api.db.must(
    "SELECT actor,detail FROM audit_log WHERE target=?",
    regular.id,
  );
  assert.equal(audit.actor, "goal_grant");
  assert.equal(JSON.parse(audit.detail).grant, source);
  assert.ok(
    !f.api.db.one(
      "SELECT 1 FROM main_messages WHERE origin=?",
      "inbox:" + regular.id,
    ),
  );
  for (const i of [extra, unrelated])
    assert.equal(f.api.s.inbox(i.id).status, "pending");

  const pending = f.request(scheduled.id, "撤销前刚到达");
  const revoke = () => f.post(path + "/revoke-approval", { grant: source });
  assert.equal((await revoke()).statusCode, 200);
  assert.equal((await revoke()).statusCode, 200);
  assert.equal((await f.post(endpoint, decision)).statusCode, 200);
  await f.api.worker.tick();
  assert.equal(f.api.s.goalGrant(goal.id), null);
  assert.equal(f.api.s.inbox(pending.id).status, "pending");
  assert.ok(
    f.api.db.one(
      "SELECT 1 FROM main_messages WHERE origin=?",
      "inbox:" + pending.id,
    ),
  );
  assert.equal(
    (
      await f.post("/inbox/" + pending.id + "/decision", {
        ...decision,
        key: uid(),
      })
    ).statusCode,
    200,
  );
  assert.equal((await revoke()).statusCode, 409);
  assert.equal(f.api.s.goalGrant(goal.id), pending.id);
  await f.post("/workspaces/" + f.w.id, { enabled: false }, "PATCH");
  await f.post("/workspaces/" + f.w.id, { enabled: true }, "PATCH");
  assert.equal(f.api.s.goalGrant(goal.id), null);
});

test("执行器未确认或授权过程中项目被更换，不能为以后各轮留下授权", async (t) => {
  const f = await fixture(t),
    goal = f.goal();
  const r = await f.api.s.start(goal.id, uid());
  const decide = (id: string) =>
    f.api.s.decide(id, { decision: "approve_goal", key: uid(), version: 1 });
  f.api.s.adapters.codex.respond = async () => {
    throw Error("连接失效");
  };
  await assert.rejects(decide(f.request(r.id, "失败请求").id));
  assert.equal(f.api.db.one("SELECT 1 FROM goal_approval_grants"), undefined);
  const canceled = f.request(r.id, "发送期间撤销").id;
  f.api.s.adapters.codex.respond = async () => {
    f.api.s.revokeGoalGrant(goal.id, canceled);
  };
  await decide(canceled);
  assert.equal(f.api.s.goalGrant(goal.id), null);
  const moved = f.api.db.workspace(f.api.db.home);
  f.api.s.adapters.codex.respond = async () => {
    assert.equal(f.api.s.goalGrant(goal.id), null);
    f.api.db.run(
      "UPDATE goals SET workspace_id=? WHERE id=?",
      moved.id,
      goal.id,
    );
    f.api.db.run("UPDATE goals SET workspace_id=? WHERE id=?", f.w.id, goal.id);
  };
  await decide(f.request(r.id, "更换项目时的请求").id);
  assert.equal(f.api.s.goalGrant(goal.id), null);
  f.api.s.adapters.codex.respond = async () => {};
  await decide(f.request(r.id, "重新授予").id);
  await f.post("/goals/" + goal.id, { state: "archived" }, "PATCH");
  await f.post("/goals/" + goal.id, { state: "active" }, "PATCH");
  assert.equal(f.api.s.goalGrant(goal.id), null);
});
