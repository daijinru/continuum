import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../apps/api/src/server.ts";
import { DirectoryUnavailable, uid } from "../apps/api/src/db.ts";
import { timeline } from "../apps/api/src/main-conversation.ts";
import { monitorTasks } from "../apps/api/src/monitor.ts";
import type { Context } from "../packages/agent-core/src/index.ts";

async function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "continuum-folder-")));
  const open = () =>
    createServer({ home: join(root, "store"), seed: false, worker: false });
  let api = await open();
  const starts: Context[] = [];
  function installAdapter() {
    api.s.adapters.codex.start = async (c) => {
      starts.push(c);
      c.reference(c.thread ?? "thread-" + c.id, "turn-" + c.id);
      c.emit({ key: "started", type: "run.started", title: "已开始" });
      c.emit({ key: "done", type: "run.completed", title: "完成" });
    };
    api.conversation.route = async () => {
      throw Error("不应调用模型");
    };
  }
  installAdapter();
  t.after(async () => {
    await api.app.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    starts,
    get api() {
      return api;
    },
    async restart() {
      await api.app.close();
      api = await open();
      installAdapter();
    },
    folder(name: string) {
      const path = join(root, name);
      mkdirSync(path);
      return path;
    },
    post(path: string, payload: object) {
      return api.app.inject({
        method: "POST",
        url: "/api/v1" + path,
        headers: { "x-continuum-token": api.token },
        payload,
      });
    },
  };
}

test("目录失效只提醒一次，问进度说清原因，重启后恢复原目录只派发原指令", async (t) => {
  const f = await fixture(t);
  const path = f.folder("项目甲"),
    moved = path + "-moved";
  const { db, conversation, worker, s } = f.api;
  db.workspace(path, "项目甲");
  renameSync(path, moved);
  const text = "整理项目甲的说明";
  conversation.route = async () => [
    {
      type: "work",
      project: "项目甲",
      text,
      target: "",
      at: "",
      cadence: "once",
      notify: "always",
    },
  ];
  const intake = await f.post("/conversation/messages", { key: uid(), text });
  assert.equal(intake.statusCode, 200, intake.body);
  const msg = db.must("SELECT * FROM user_messages");
  s.commission("不依赖项目甲的工作", uid());
  conversation.route = async () => {
    throw Error("不应调用模型");
  };
  await worker.tick();
  await worker.tick();
  const notices = timeline(db).filter((m) => m.kind === "directory");
  assert.equal(notices.length, 1);
  const [notice] = notices;
  assert.deepEqual(
    notice.refs.map((r: { id: string }) => r.id),
    [msg.goal_id],
  );
  assert.equal(notice.directoryPath, path);
  assert.equal(
    db.one("SELECT 1 FROM agent_runs WHERE goal_id=?", msg.goal_id),
    undefined,
  );
  assert.match(f.starts[0].instruction, /不依赖/);
  assert.equal(
    monitorTasks(db, new Map()).find((g) => g.id === msg.goal_id)?.state,
    "blocked",
  );
  await conversation.send({
    key: uid(),
    text: "进度怎么样？",
    replyTo: notice.id,
  });
  assert.match(timeline(db).at(-1)!.body, /尚未开始.*文件夹找不到.*确认新位置/);
  await conversation.send({ key: uid(), text: "继续", replyTo: notice.id });
  assert.match(timeline(db).at(-1)!.body, /仍在等原目录恢复/);
  assert.equal(
    db.must("SELECT status FROM user_messages WHERE id=?", msg.id).status,
    "queued",
  );
  await f.restart();
  await f.api.worker.tick();
  assert.equal(
    timeline(f.api.db).filter((m) => m.kind === "directory").length,
    1,
  );
  renameSync(moved, path);
  await f.api.worker.tick();
  const retry = await f.post("/conversation/directories/" + notice.id, {});
  assert.equal(retry.statusCode, 200, retry.body);
  await f.api.conversation.send({
    key: uid(),
    text: "继续",
    replyTo: notice.id,
  });
  await f.api.worker.tick();
  assert.equal(f.starts.length, 2);
  assert.equal(f.starts[1].workspace, path);
  assert.deepEqual(
    f.api.db
      .all("SELECT key FROM agent_runs WHERE goal_id=?", msg.goal_id)
      .map((r) => r.key),
    [msg.id],
  );
  const restored = timeline(f.api.db).find((m) => m.id === notice.id)!;
  assert.ok(restored.directoryResolvedAt);
  assert.equal(restored.resolvedBy, null);
});

test("多项委托共用目录时单独确认新位置，重复提交、软链接和停用项目都不会误派发", async (t) => {
  const f = await fixture(t);
  const { db, s, worker, conversation } = f.api;
  const path = f.folder("原项目"),
    moved = path + "-moved",
    disabled = db.workspace(f.folder("已停用"));
  const workspace = db.workspace(path);
  const one = s.commission("更新说明", uid(), workspace.id);
  const two = s.commission("更新测试", uid(), workspace.id);
  renameSync(path, moved);
  symlinkSync(moved, path);
  db.run("UPDATE workspaces SET enabled=0 WHERE id=?", disabled.id);
  await worker.tick();
  await worker.tick();
  const notices = timeline(db).filter((m) => m.kind === "directory");
  assert.equal(notices.length, 2);
  const notice = notices.find((m) => m.refs[0].id === one.id)!;
  assert.match(notice.body, /指向的位置已改变/);
  await conversation.send({ key: uid(), text: "继续" });
  assert.match(
    timeline(db).at(-1)!.body,
    /更新说明.*更新测试|更新测试.*更新说明/,
  );
  const endpoint = "/conversation/directories/" + notice.id;
  for (const payload of [
    {},
    { path: join(f.root, "不存在") },
    { path: disabled.path },
  ])
    assert.equal((await f.post(endpoint, payload)).statusCode, 422);
  db.run("UPDATE goals SET state='paused' WHERE id=?", one.id);
  assert.equal((await f.post(endpoint, { path: moved })).statusCode, 409);
  db.run("UPDATE goals SET state='active' WHERE id=?", one.id);
  const confirms = await Promise.all([
    f.post(endpoint, { path: moved }),
    f.post(endpoint, { path: moved }),
  ]);
  assert.ok(confirms.every((r) => r.statusCode === 200));
  assert.equal(confirms[0].json().data.id, confirms[1].json().data.id);
  assert.equal((await f.post(endpoint, { path: f.root })).statusCode, 409);
  assert.equal(db.projects().length, 2);
  assert.equal(
    db.must("SELECT path FROM workspaces WHERE id=?", workspace.id).path,
    path,
  );
  assert.equal(s.goal(two.id).workspace_id, workspace.id);
  await f.restart();
  await Promise.all([f.api.worker.tick(), f.api.worker.tick()]);
  assert.equal(f.starts.length, 1);
  assert.equal(f.starts[0].workspace, moved);
  assert.equal(f.starts[0].managedCommission, false);
  assert.match(f.starts[0].instruction, /更新说明/);
  assert.equal(
    f.api.db.all("SELECT * FROM directory_holds WHERE resolved_at IS NULL")
      .length,
    1,
  );
  assert.equal(
    (await f.post(endpoint, { path: moved })).json().data.id,
    confirms[0].json().data.id,
  );
});

test("手动继续也保留原线程和执行键，已经交给执行器的失败不会触发目录重试", async (t) => {
  const f = await fixture(t);
  const { db, s, worker } = f.api;
  const goal = s.commission("整理资料", uid());
  await worker.tick();
  const thread = db.must("SELECT thread_id FROM agent_runs").thread_id;
  const original = db.allowed(goal.workspace_id),
    moved = original + "-moved";
  renameSync(original, moved);
  const key = uid();
  await assert.rejects(
    s.start(goal.id, key, "接着写第二节", true),
    DirectoryUnavailable,
  );
  const notice = timeline(db).at(-1)!;
  const confirmed = await f.post("/conversation/directories/" + notice.id, {
    path: moved,
  });
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  await worker.tick();
  await s.start(goal.id, key, "接着写第二节", true);
  assert.equal(f.starts.length, 2);
  assert.equal(f.starts[1].thread, thread);
  assert.equal(f.starts[1].managedCommission, false);
  assert.match(f.starts[1].instruction, /接着写第二节/);
  s.adapters.codex.start = async () => {
    throw new DirectoryUnavailable("执行器端目录无效");
  };
  const failed = s.commission("启动后异常", uid());
  await worker.tick();
  await worker.tick();
  assert.equal(
    db.must("SELECT status FROM agent_runs WHERE goal_id=?", failed.id).status,
    "failed",
  );
  assert.equal(
    db.one("SELECT 1 FROM directory_holds WHERE goal_id=?", failed.id),
    undefined,
  );
});

test("每日委托错过多个时间只补原来的一次，回复提醒也可确认新目录", async (t) => {
  const f = await fixture(t);
  const { db, s, worker, agenda, conversation } = f.api;
  const path = f.folder("项目"),
    moved = path + " 新位置";
  const g = s.createCommission("每日整理", uid(), db.workspace(path).id, false);
  const lastWeek = new Date(Date.now() - 7 * 86_400_000);
  db.run(
    "INSERT INTO main_tasks(goal_id,mode,cadence,clock,next_at,notify) VALUES(?,'work','daily','09:00',?,'always')",
    g.id,
    lastWeek.toISOString(),
  );
  agenda.tick(lastWeek);
  renameSync(path, moved);
  await worker.tick();
  const notice = timeline(db).at(-1)!;
  assert.equal(notice.kind, "directory");
  agenda.tick();
  const work = db.must("SELECT * FROM user_messages WHERE goal_id=?", g.id);
  const reply = { key: uid(), text: "改用 " + moved, replyTo: notice.id };
  await Promise.all([conversation.send(reply), conversation.send(reply)]);
  await conversation.send({ key: uid(), text: "继续" });
  await worker.tick();
  agenda.tick();
  await worker.tick();
  assert.equal(
    db.all("SELECT * FROM user_messages WHERE goal_id=?", g.id).length,
    1,
  );
  assert.equal(
    db.must("SELECT key FROM agent_runs WHERE goal_id=?", g.id).key,
    work.id,
  );
  assert.ok(
    Date.parse(
      db.must("SELECT next_at FROM main_tasks WHERE goal_id=?", g.id).next_at,
    ) > Date.now(),
  );
  assert.deepEqual(
    f.starts.map((c) => c.workspace),
    [moved],
  );
});

test("解释回复期间原工作已自动恢复，迟到的重试只返回进度", async (t) => {
  const f = await fixture(t);
  const { db, s, worker, conversation } = f.api;
  const path = f.folder("项目"),
    moved = path + "-moved";
  const project = db.workspace(path);
  const key = uid(),
    goal = s.commission("更新索引", key, project.id);
  renameSync(path, moved);
  await worker.tick();
  const notice = timeline(db).at(-1)!;
  renameSync(moved, path);
  db.run("UPDATE workspaces SET enabled=0 WHERE id=?", project.id);
  await worker.tick();
  assert.equal(f.starts.length, 0);
  db.run("UPDATE workspaces SET enabled=1 WHERE id=?", project.id);
  conversation.route = async () => {
    await worker.tick();
    return [
      {
        type: "rerun",
        target: goal.id,
        text: "继续做",
        cadence: "once",
        notify: "always",
        at: "",
      },
    ];
  };
  await conversation.send({
    key: uid(),
    text: "现在可以接着整理了",
    replyTo: notice.id,
  });
  await worker.tick();
  assert.equal(f.starts.length, 1);
  assert.deepEqual(
    db.all("SELECT id FROM user_messages").map((m) => m.id),
    [key],
  );
  assert.equal(timeline(db).filter((m) => m.kind === "directory").length, 1);
});
