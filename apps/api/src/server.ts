import Fastify from "fastify";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { Store, Problem, now, uid } from "./db.ts";
import { Service } from "./service.ts";
import { Worker } from "../../worker/src/index.ts";
import { monitorTasks, processSampler } from "./monitor.ts";
import { MainConversation, sendInput, timeline } from "./main-conversation.ts";
import { MainAgenda } from "./main-agenda.ts";
import { goalUsage, workspaceUsage } from "./usage.ts";
import {
  goalInput,
  startInput,
  states,
  settingsInput,
  scheduleInput,
  chatInput,
  windowInput,
  line,
} from "../../../packages/contracts/src/index.ts";
import { outputs } from "../../../packages/contracts/src/outputs.ts";
import { redact } from "../../../packages/agent-core/src/index.ts";
import {
  generate,
  acknowledge,
  unpack,
  reports,
} from "../../../packages/briefing/src/index.ts";
import { checkCodex } from "../../../packages/codex-adapter/src/index.ts";
export async function createServer(
  options: {
    home?: string;
    seed?: boolean;
    delay?: number;
    worker?: boolean;
  } = {},
) {
  const db = new Store(options.home),
    s = new Service(db, options.delay),
    worker = new Worker(s),
    conversation = new MainConversation(s),
    agenda = new MainAgenda(s);
  await s.recover();
  if (options.seed !== false) s.seed();
  const app = Fastify({ bodyLimit: 32768, logger: false });
  const token = randomBytes(32).toString("hex"),
    prefix = "/api/v1";
  app.addHook("onRequest", async (req, reply) => {
    const host = req.headers.host || "";
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host))
      throw new Problem("仅允许通过本机地址访问", 403);
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
      );
    if (req.url.startsWith(prefix)) reply.header("Cache-Control", "no-store");
    if (
      !["GET", "HEAD"].includes(req.method) &&
      (req.headers["x-continuum-token"] !== token ||
        (req.headers.origin && req.headers.origin !== "http://" + host))
    )
      throw new Problem("本地会话无效，请刷新页面", 403);
  });
  app.setErrorHandler((err, _req, reply) => {
    const validation = err instanceof z.ZodError;
    const code = validation ? 422 : (err as Problem).statusCode || 500;
    reply.status(code).send({
      data: null,
      error: validation
        ? "请检查输入字段"
        : code >= 500 && !(err instanceof Problem)
          ? "服务暂时无法处理请求"
          : redact((err as Error).message),
    });
  });
  type Req = { id: string; body: any; q: Record<string, string> };
  const route = (
    method: "GET" | "POST" | "PATCH",
    path: string,
    handler: (req: Req) => any,
  ) =>
    app.route({
      method,
      url: prefix + path,
      handler: async (req) => {
        const data = await handler({
          id: (req.params as any).id,
          body: req.body,
          q: req.query as any,
        });
        const parsed = outputs[method + " " + path].safeParse(data);
        if (!parsed.success) throw new Problem("服务返回了无效记录", 500);
        return { data: parsed.data };
      },
    });
  const get = (p: string, f: (r: Req) => any) => route("GET", p, f),
    post = (p: string, f: (r: Req) => any) => route("POST", p, f);
  const page = (q: Req["q"]) =>
    z.coerce.number().int().min(1).max(500).default(100).parse(q.limit);
  const offset = (q: Req["q"]) =>
    z.coerce.number().int().nonnegative().default(0).parse(q.offset);
  get("/session", () => ({ token }));
  get("/health", () => ({ ready: true }));
  get("/conversation", ({ q }) =>
    timeline(db, q.before ? offset({ offset: q.before }) : undefined),
  );
  post("/conversation/messages", ({ body }) =>
    conversation.send(sendInput.parse(body)),
  );
  const processes = processSampler(() => s.adapters.codex.processRoots?.() ?? new Map());
  get("/system/monitor", async () => ({
    ...await processes(),
    tasks: monitorTasks(db, agenda.active),
  }));
  get("/system/status", () => ({
    worker: { lastTick: worker.lastTick, error: worker.error },
    connections: db.all("SELECT * FROM agent_connections"),
    db: db.home,
  }));
  get("/agent-connections", () =>
    db.all("SELECT * FROM agent_connections").map((c) => ({
      ...c,
      capabilities: {
        start: true,
        observe: true,
        continueThread: true,
        interrupt: true,
        liveApproval: true,
        artifactDiscovery: c.id === "codex",
      },
    })),
  );
  post("/agent-connections/check", async () => {
    const check = await checkCodex();
    db.run(
      "UPDATE agent_connections SET state=?,detail=? WHERE id='codex'",
      check.ready ? "ready" : "unavailable",
      [check.version, check.detail].join(" · "),
    );
    return check;
  });
  get("/settings", () => ({
    ...s.config(),
    usage: workspaceUsage(db),
    workspaces: db.all("SELECT * FROM workspaces"),
    connections: db.all("SELECT * FROM agent_connections"),
    worker: worker.lastTick,
    db: db.home,
  }));
  route("PATCH", "/settings", ({ body }) => {
    db.run(
      "UPDATE settings SET config=?",
      JSON.stringify({ ...s.config(), ...settingsInput.parse(body) }),
    );
    return s.config();
  });
  post("/workspaces", ({ body }) =>
    db.workspace(z.object({ path: line }).strict().parse(body).path),
  );
  route("PATCH", "/workspaces/:id", ({ id, body }) => {
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(body);
    db.must("SELECT * FROM workspaces WHERE id=?", id);
    db.run("UPDATE workspaces SET enabled=? WHERE id=?", Number(enabled), id);
    return { id, enabled };
  });
  get("/goals", ({ q }) =>
    db.all(
      "SELECT g.*,w.name workspace,CASE WHEN g.state='blocked' THEN 'blocked' WHEN EXISTS(SELECT 1 FROM stories st WHERE st.goal_id=g.id AND st.category='risk' AND st.verification='disputed') THEN 'at_risk' WHEN EXISTS(SELECT 1 FROM stories st WHERE st.goal_id=g.id AND st.verification='verified') THEN 'on_track' ELSE 'unknown' END health,(SELECT count(*) FROM inbox_items i WHERE i.goal_id=g.id AND i.status IN('pending','deferred')) pending,(SELECT status FROM agent_runs r WHERE r.goal_id=g.id ORDER BY created DESC LIMIT 1) latest FROM goals g JOIN workspaces w ON w.id=g.workspace_id ORDER BY g.updated DESC LIMIT ? OFFSET ?",
      page(q),
      offset(q),
    ),
  );
  post("/goals", ({ body }) => s.createGoal(goalInput.parse(body)));
  post("/commissions", ({ body }) => {
    const b = z
      .object({
        request: line,
        key: z.string().uuid(),
        workspaceId: z.string().uuid().optional(),
      })
      .strict()
      .parse(body);
    return s.commission(b.request, b.key, b.workspaceId);
  });
  get("/goals/:id/reports", ({ id }) => {
    s.goal(id);
    return reports(db, 0, Number.MAX_SAFE_INTEGER, id);
  });
  post("/goals/:id/preferences", ({ id, body }) => {
    const { text } = z
      .object({ text: line.max(1000) })
      .strict()
      .parse(body);
    const g = s.goal(id),
      constraints: string[] = JSON.parse(g.constraints_json),
      value = redact(text);
    if (!constraints.includes(value)) {
      if (constraints.length >= 30)
        throw new Problem("要求过多，请先在目标设置中整理");
      db.run(
        "UPDATE goals SET constraints_json=?,updated=? WHERE id=?",
        JSON.stringify([...constraints, value]),
        now(),
        id,
      );
    }
    return s.goal(id);
  });
  get("/goals/:id", ({ id }) => ({
    ...s.goal(id),
    usage: goalUsage(db, id),
    arrangement:
      db.one(
        "SELECT mode,cadence,notify,next_at,last_note,succeeded,attempted FROM main_tasks WHERE goal_id=?",
        id,
      ) || null,
    nativeResults: db.all(
      `SELECT m.id,m.body,m.created FROM main_refs r JOIN main_messages m ON m.id=r.message_id WHERE r.goal_id=? AND (m.origin LIKE 'watch:%' OR m.origin LIKE 'remind:%' OR m.origin LIKE 'watch-failed:%') ORDER BY seq DESC LIMIT 40`,
      id,
    ),
    checks: db.all("SELECT * FROM criterion_checks WHERE goal_id=?", id),
    workspace: db.must(
      "SELECT w.* FROM workspaces w JOIN goals g ON g.workspace_id=w.id WHERE g.id=?",
      id,
    ),
    jobs: db.all(
      "SELECT * FROM schedule_jobs WHERE goal_id=? ORDER BY next_at",
      id,
    ),
    limits: worker.limits(id),
    artifacts: db.all("SELECT * FROM artifacts WHERE goal_id=?", id),
    messages: db.all(
      "SELECT * FROM user_messages WHERE goal_id=? ORDER BY created DESC LIMIT 100",
      id,
    ),
  }));
  route("PATCH", "/goals/:id", ({ id, body }) => {
    const b = goalInput
        .omit({ workspaceId: true, provider: true })
        .partial()
        .extend({ state: states.optional() })
        .strict()
        .parse(body),
      g = s.goal(id);
    db.run(
      "UPDATE goals SET title=?,description=?,criteria=?,constraints_json=?,priority=?,state=?,updated=? WHERE id=?",
      redact(b.title ?? g.title),
      redact(b.description ?? g.description),
      b.criteria ? JSON.stringify(b.criteria.map(redact)) : g.criteria,
      b.constraints
        ? JSON.stringify(b.constraints.map(redact))
        : g.constraints_json,
      b.priority ?? g.priority,
      b.state ?? g.state,
      now(),
      id,
    );
    return s.goal(id);
  });
  post("/goals/:id/check", ({ id, body }) => {
    const g = s.goal(id),
      input = z
        .object({ criterion: line, checked: z.boolean() })
        .strict()
        .parse(body);
    if (!JSON.parse(g.criteria).includes(input.criterion))
      throw new Problem("验收项不存在");
    db.tx(() => {
      if (input.checked)
        db.run(
          "INSERT OR REPLACE INTO criterion_checks VALUES(?,?,?)",
          id,
          input.criterion,
          now(),
        );
      else
        db.run(
          "DELETE FROM criterion_checks WHERE goal_id=? AND criterion=?",
          id,
          input.criterion,
        );
      db.run(
        "INSERT INTO audit_log(actor,action,target,detail,created) VALUES(?,?,?,?,?)",
        "user",
        "criterion.check",
        id,
        JSON.stringify(input),
        now(),
      );
    });
    return input;
  });
  post("/goals/:id/start", ({ id, body }) => {
    const b = startInput.parse(body);
    return s.start(id, b.key, b.instruction, b.continue);
  });
  for (const [action, state] of [
    ["pause", "paused"],
    ["resume", "active"],
  ])
    post("/goals/:id/" + action, ({ id }) => {
      s.goal(id);
      db.run("UPDATE goals SET state=?,updated=? WHERE id=?", state, now(), id);
      return s.goal(id);
    });
  post("/goals/:id/interrupt", async ({ id }) => {
    const r = db.must(
      "SELECT * FROM agent_runs WHERE goal_id=? AND status IN('running','waiting_approval')",
      id,
    );
    await s.adapters[r.provider].interrupt(r.id);
    return s.run(r.id);
  });
  post("/runs/:id/reconcile", ({ id }) => s.reconcile(id));
  get("/goals/:id/runs", ({ id, q }) =>
    db.all(
      "SELECT * FROM agent_runs WHERE goal_id=? ORDER BY created DESC LIMIT ? OFFSET ?",
      id,
      page(q),
      offset(q),
    ),
  );
  get("/runs/:id", ({ id }) => s.run(id));
  get("/runs/:id/events", ({ id, q }) =>
    db.all(
      "SELECT * FROM raw_events WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?",
      id,
      offset({ offset: q.cursor }),
      page(q),
    ),
  );
  get("/runs/:id/artifacts", ({ id }) =>
    db.all("SELECT * FROM artifacts WHERE run_id=?", id),
  );
  get("/stories", ({ q }) =>
    db.all(
      "SELECT s.*,g.title goal,g.provider FROM stories s JOIN goals g ON g.id=s.goal_id WHERE (? IS NULL OR goal_id=?) AND s.updated>=? ORDER BY materiality DESC,s.updated DESC LIMIT ? OFFSET ?",
      q.goalId || null,
      q.goalId || null,
      q.since || "",
      page(q),
      offset(q),
    ),
  );
  get("/stories/:id", ({ id }) =>
    db.must("SELECT * FROM stories WHERE id=?", id),
  );
  get("/stories/:id/events", ({ id, q }) =>
    db.all(
      "SELECT e.* FROM raw_events e JOIN story_events se ON se.event_id=e.id WHERE se.story_id=? AND e.seq<=? ORDER BY e.seq DESC LIMIT ? OFFSET ?",
      id,
      q.until ? offset({ offset: q.until }) : Number.MAX_SAFE_INTEGER,
      page(q),
      offset(q),
    ),
  );
  get("/briefings", ({ q }) =>
    db
      .all(
        "SELECT * FROM briefings ORDER BY rowid DESC LIMIT ? OFFSET ?",
        page(q),
        offset(q),
      )
      .map(unpack),
  );
  get("/briefings/:id", ({ id }) =>
    unpack(db.must("SELECT * FROM briefings WHERE id=?", id)),
  );
  post("/briefings/generate", ({ body }) =>
    generate(db, windowInput.parse(body?.window ?? "since")),
  );
  post("/briefings/:id/acknowledge", ({ id }) => acknowledge(db, id));
  get("/inbox", ({ q }) =>
    db.all(
      "SELECT i.*,g.title goal,r.provider FROM inbox_items i JOIN goals g ON g.id=i.goal_id JOIN agent_runs r ON r.id=i.run_id WHERE (? IS NULL OR i.status=?) ORDER BY i.status IN('pending','deferred') DESC,i.created DESC LIMIT ? OFFSET ?",
      q.status || null,
      q.status || null,
      page(q),
      offset(q),
    ),
  );
  get("/inbox/:id", ({ id }) => ({
    ...s.inbox(id),
    audit: db.all(
      "SELECT * FROM audit_log WHERE target=? ORDER BY id DESC",
      id,
    ),
  }));
  post("/inbox/:id/decision", ({ id, body }) => s.decide(id, body));
  get("/activity", ({ q }) => {
    const clauses = ["e.seq>?"],
      args: (string | number)[] = [offset({ offset: q.cursor })];
    for (const [key, col] of Object.entries({
      goalId: "e.goal_id",
      type: "e.type",
      runId: "e.run_id",
      severity: "e.severity",
      provider: "r.provider",
    }))
      if (q[key]) {
        clauses.push(col + "=?");
        args.push(q[key]);
      }
    if (q.search) {
      clauses.push("(e.title LIKE ? OR e.method LIKE ?)");
      args.push("%" + q.search + "%", "%" + q.search + "%");
    }
    return db.all(
      "SELECT e.*,g.title goal,r.provider FROM raw_events e JOIN goals g ON g.id=e.goal_id JOIN agent_runs r ON r.id=e.run_id WHERE " +
        clauses.join(" AND ") +
        " ORDER BY e.seq " +
        (q.cursor ? "ASC" : "DESC") +
        " LIMIT ? OFFSET ?",
      ...args,
      page(q),
      offset(q),
    );
  });
  get("/events/:id", ({ id }) =>
    db.must("SELECT * FROM raw_events WHERE id=?", id),
  );
  post("/goals/:id/schedules", ({ id, body }) => {
    const g = s.goal(id);
    if (db.one("SELECT 1 FROM main_tasks WHERE goal_id=?", id))
      throw new Problem("请在主对话里调整这项委托的时间，避免重复排期。");
    db.allowed(g.workspace_id);
    if (g.state !== "active") throw new Problem("请先恢复目标");
    const b = scheduleInput.parse(body),
      jobId = uid();
    db.run(
      "INSERT INTO schedule_jobs(id,goal_id,kind,instruction,minutes,next_at,state) VALUES(?,?,?,?,?,?,'enabled')",
      jobId,
      id,
      b.kind,
      redact(b.instruction),
      b.minutes,
      new Date(b.nextAt).toISOString(),
    );
    return db.must("SELECT * FROM schedule_jobs WHERE id=?", jobId);
  });
  route("PATCH", "/goals/:id/limits", ({ id, body }) => {
    s.goal(id);
    const cfg = settingsInput.omit({ dailyTime: true }).parse(body);
    db.run(
      "INSERT INTO goal_limits VALUES(?,?) ON CONFLICT(goal_id) DO UPDATE SET config=excluded.config",
      id,
      JSON.stringify({ ...worker.limits(id), ...cfg }),
    );
    return worker.limits(id);
  });
  post("/schedules/:id/stop", ({ id }) => {
    db.must("SELECT * FROM schedule_jobs WHERE id=?", id);
    db.run(
      "UPDATE schedule_jobs SET state='disabled',lease=NULL,lease_until=NULL WHERE id=?",
      id,
    );
    return { id };
  });
  post("/chat/messages", ({ body }) => {
    const b = chatInput.parse(body);
    s.goal(b.goalId);
    let context = "";
    if (b.scope === "story" || b.scope === "approval") {
      const row =
        b.scope === "story"
          ? db.must("SELECT * FROM stories WHERE id=?", b.ref)
          : s.inbox(b.ref);
      if (row.goal_id !== b.goalId) throw new Problem("上下文不属于此目标");
      context = row.title + "\n";
    } else if (
      (b.scope === "goal" && b.ref !== b.goalId) ||
      (b.scope === "all" && b.ref !== "all")
    )
      throw new Problem("上下文不匹配");
    const source =
      b.scope === "story"
        ? db.one(
            "SELECT e.run_id id FROM stories s JOIN raw_events e ON e.seq=s.last_seq WHERE s.id=?",
            b.ref,
          )
        : b.scope === "approval"
          ? { id: s.inbox(b.ref).run_id }
          : b.scope === "goal"
            ? db.one(
                "SELECT id FROM agent_runs WHERE goal_id=? ORDER BY created DESC LIMIT 1",
                b.goalId,
              )
            : null;
    const id = uid();
    db.run(
      "INSERT INTO user_messages(id,goal_id,scope,ref,content,created,status,source_run) VALUES(?,?,?,?,?,?,'queued',?)",
      id,
      b.goalId,
      b.scope,
      b.ref,
      redact(context + b.content),
      now(),
      source?.id || null,
    );
    return db.must("SELECT * FROM user_messages WHERE id=?", id);
  });
  app.get(prefix + "/stream", (req, reply) => {
    let cursor = offset({
      offset: String(
        req.headers["last-event-id"] || (req.query as any).cursor || 0,
      ),
    });
    const latest = db.must(
      "SELECT coalesce(max(seq),0) seq FROM raw_events",
    ).seq;
    if (cursor > latest) cursor = 0;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");
    let blocked = false;
    const flush = () => {
      if (blocked || res.destroyed) return;
      for (;;) {
        const rows = db.all(
          "SELECT seq,id,goal_id,type FROM raw_events WHERE seq>? ORDER BY seq LIMIT 100",
          cursor,
        );
        for (const e of rows) {
          cursor = e.seq;
          if (
            !res.write(
              "id: " +
                e.seq +
                "\nevent: change\ndata: " +
                JSON.stringify(e) +
                "\n\n",
            )
          ) {
            blocked = true;
            res.once("drain", () => {
              blocked = false;
              flush();
            });
            return;
          }
        }
        if (rows.length < 100) return;
      }
    };
    s.bus.on("event", flush);
    flush();
    const timer = setInterval(() => {
      if (!blocked) res.write(": heartbeat\n\n");
    }, 15000);
    res.on("close", () => {
      clearInterval(timer);
      s.bus.off("event", flush);
    });
  });
  const dist = resolve("apps/web/dist");
  app.get("/*", (req, reply) => {
    const path = (req.params as any)["*"];
    if (path.startsWith("api/") || path.includes(".."))
      throw new Problem("路径不存在", 404);
    const asset = /^assets\/[\w.-]+\.(css|js)$/.exec(path);
    if (path.includes(".") && !asset) throw new Problem("资源不存在", 404);
    try {
      return reply
        .type(
          asset
            ? asset[1] === "css"
              ? "text/css"
              : "application/javascript"
            : "text/html",
        )
        .send(readFileSync(join(dist, asset ? path : "index.html")));
    } catch {
      throw new Problem("请先构建前端资源", 404);
    }
  });
  if (options.worker !== false) {
    worker.start();
    agenda.start();
  }
  app.addHook("onClose", async () => {
    await Promise.all([worker.stop(), agenda.stop(), conversation.drain()]);
    s.close();
  });
  return { app, s, db, worker, token, conversation, agenda };
}
