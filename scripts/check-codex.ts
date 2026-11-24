import { mkdtempSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "../apps/api/src/server.ts";
import { uid } from "../apps/api/src/db.ts";
const workspace = realpathSync(
    mkdtempSync(join(tmpdir(), "continuum-scratch-")),
  ),
  home = mkdtempSync(join(tmpdir(), "continuum-live-db-"));
execFileSync("git", ["init", "-q", workspace]);
const { app, token } = await createServer({ home, seed: false, worker: false });
async function api(path: string, payload?: Record<string, unknown>) {
  const res = await app.inject({
    method: payload ? "POST" : "GET",
    url: "/api/v1" + path,
    headers: { "x-continuum-token": token },
    payload,
  });
  if (res.statusCode >= 400) throw Error(String(res.json().error));
  return res.json().data;
}
try {
  const health = await api("/agent-connections/check", {});
  console.log(health);
  if (!health.ready) throw Error("模型连接不可用");
  const w = await api("/workspaces", { path: workspace });
  const g = await api("/goals", {
    title: "临时仓库 README 验证",
    description:
      "只用 apply_patch 在项目根目录新增 README.md。仅写入一行 Continuum scratch check。",
    criteria: ["README 内容为 Continuum scratch check"],
    constraints: ["不要运行任何 shell 命令，也不要访问网络。"],
    provider: "codex",
    workspaceId: w.id,
  });
  let r = await api("/goals/" + g.id + "/start", { key: uid() });
  const deadline = Date.now() + 120000;
  while (!r.finished && r.status !== "unknown" && Date.now() < deadline) {
    for (const i of await api("/inbox?status=pending")) {
      const action = JSON.parse(i.action);
      const edits = action.changes;
      const onlyReadme =
        Array.isArray(edits) &&
        edits.length === 1 &&
        !action.grantRoot &&
        resolve(workspace, edits[0].path) === join(workspace, "README.md") &&
        edits[0].kind?.type === "add" &&
        edits[0].diff?.includes("Continuum scratch check");
      await api("/inbox/" + i.id + "/decision", {
        decision: onlyReadme ? "approve" : "deny",
        version: i.version,
        key: uid(),
      });
      console.log(
        "审批",
        onlyReadme ? "仅放行临时 README 补丁" : "拒绝其他操作",
      );
    }
    await new Promise((r) => setTimeout(r, 200));
    r = await api("/runs/" + r.id);
  }
  if (!r.finished && r.status !== "unknown")
    await api("/goals/" + g.id + "/interrupt", {});
  const file = join(workspace, "README.md");
  const verified =
    existsSync(file) &&
    readFileSync(file, "utf8").trim() === "Continuum scratch check";
  const artifacts = await api("/runs/" + r.id + "/artifacts"),
    events = await api("/runs/" + r.id + "/events"),
    brief = await api("/briefings/generate", { window: "since" });
  const evidence =
    artifacts.some((a: { path: string }) => a.path === file) &&
    brief.sections.outcomes.some(
      (s: { verification: string }) => s.verification === "verified",
    );
  console.log({
    status: r.status,
    verified,
    evidence,
    events: events.map((e: { type: string }) => e.type),
    workspace,
    home,
  });
  if (!verified || r.status !== "succeeded" || !evidence) process.exitCode = 1;
  if (verified && r.status === "succeeded" && evidence) {
    let next = await api("/goals/" + g.id + "/start", {
      key: uid(),
      continue: true,
      instruction:
        "上一轮 README 已经验收。本轮仅用文字回复“验收完成”。禁止调用工具或更改任何文件。",
    });
    const until = Date.now() + 60000;
    while (!next.finished && next.status !== "unknown" && Date.now() < until) {
      for (const item of await api("/inbox?status=pending")) {
        if (item.kind === "approval")
          await api("/inbox/" + item.id + "/decision", {
            key: uid(),
            decision: "deny",
            version: item.version,
          });
      }
      await new Promise((r) => setTimeout(r, 200));
      next = await api("/runs/" + next.id);
    }
    const sameThread =
      r.thread_id === next.thread_id &&
      r.turn_id !== next.turn_id &&
      r.id !== next.id;
    console.log({ followUp: next.status, sameThread });
    if (!sameThread || next.status !== "succeeded") process.exitCode = 1;
  }
} finally {
  await app.close();
}
