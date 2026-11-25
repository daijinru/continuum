import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { Store, now, uid, Problem, type Row } from "./db.ts";
import { recordUsage } from "./usage.ts";
import { reportRun, post } from "./main-conversation.ts";
import {
  type AgentAdapter,
  type Context,
  type Observation,
  type RunStatus,
  canMove,
  redact,
} from "../../../packages/agent-core/src/index.ts";
import {
  DemoAdapter,
  fixture,
} from "../../../packages/demo-adapter/src/index.ts";
import { CodexAdapter } from "../../../packages/codex-adapter/src/index.ts";
import {
  projectStory,
  generate,
} from "../../../packages/briefing/src/index.ts";
import {
  goalInput,
  decisionInput,
  type GoalInput,
} from "../../../packages/contracts/src/index.ts";

const open = "('pending','deferred')";
export class Service {
  db: Store;
  bus = new EventEmitter();
  closed = false;
  deciding = new Set<string>();
  adapters: Record<string, AgentAdapter>;
  demo: DemoAdapter;
  constructor(db: Store, delay = 400) {
    this.db = db;
    this.demo = new DemoAdapter(delay);
    this.adapters = { demo: this.demo, codex: new CodexAdapter() };
  }
  goal(id: string) {
    return this.db.must("SELECT * FROM goals WHERE id=?", id);
  }
  run(id: string) {
    return this.db.must("SELECT * FROM agent_runs WHERE id=?", id);
  }
  inbox(id: string) {
    return this.db.must("SELECT * FROM inbox_items WHERE id=?", id);
  }
  config() {
    return JSON.parse(this.db.must("SELECT * FROM settings").config);
  }
  createGoal(input: GoalInput) {
    const g = goalInput.parse(input);
    this.db.allowed(g.workspaceId);
    const id = uid();
    this.db.run(
      "INSERT INTO goals VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      id,
      redact(g.title),
      redact(g.description),
      JSON.stringify(g.criteria.map(redact)),
      JSON.stringify(g.constraints.map(redact)),
      "active",
      g.priority,
      g.workspaceId,
      g.provider,
      now(),
      now(),
    );
    return this.goal(id);
  }
  commission(request: string, key: string, workspaceId?: string) {
    // Queue the first instruction and create the goal together; a retry of the
    // same submission must not launch another goal or run.
    return this.db.tx(() => this.createCommission(request, key, workspaceId));
  }
  // Also used in the main-conversation transaction: message + all goals +
  // dispatch intents commit together, before any provider action starts.
  createCommission(
    request: string,
    key: string,
    workspaceId?: string,
    queue = true,
  ) {
    const prior = this.db.one(
      "SELECT goal_id,content FROM user_messages WHERE id=?",
      key,
    );
    if (prior) {
      if (prior.content !== redact(request))
        throw new Problem("提交编号已使用", 409);
      return this.goal(prior.goal_id);
    }
    const managed = !workspaceId;
    if (managed) {
      const root = join(realpathSync(this.db.home), "commissions");
      mkdirSync(root, { recursive: true, mode: 0o700 });
      if (realpathSync(root) !== root) throw new Problem("委托目录已改变");
      workspaceId = this.db.workspace(mkdtempSync(join(root, "task-")), undefined, false).id;
    }
    const g = this.createGoal({
      title: request.split(/\n/)[0].slice(0, 80),
      description: request,
      criteria: ["按原始要求交付可直接使用的结果"],
      constraints: [],
      provider: "codex",
      priority: 3,
      workspaceId: workspaceId!,
    });
    if (managed)
      this.db.run(
        "INSERT INTO managed_commissions(goal_id,workspace_id) VALUES(?,?)",
        g.id,
        g.workspace_id,
      );
    if (queue)
      this.db.run(
        "INSERT INTO user_messages(id,goal_id,scope,ref,content,created,status) VALUES(?,?,'goal',?,?,?,'queued')",
        key,
        g.id,
        g.id,
        redact(request),
        now(),
      );
    return g;
  }
  context(run: Row): Context {
    const goal = this.goal(run.goal_id);
    const workspace = this.db.allowed(goal.workspace_id);
    return {
      id: run.id,
      workspace,
      managedCommission: !!this.db.one(
        "SELECT 1 FROM managed_commissions WHERE goal_id=? AND workspace_id=?",
        goal.id,
        goal.workspace_id,
      ),
      instruction: run.instruction,
      thread: run.thread_id,
      turn: run.turn_id,
      threadUsage: (thread, counts) => {
        if (!this.closed) recordUsage(this.db, "thread:" + thread, goal.id, counts);
      },
      reference: (thread, turn) => {
        if (!this.closed)
          this.db.run(
            "UPDATE agent_runs SET thread_id=?,turn_id=coalesce(?,turn_id) WHERE id=?",
            thread,
            turn || null,
            run.id,
          );
      },
      emit: (e) => {
        if (!this.closed) this.event(run.id, e);
      },
    };
  }
  move(run: Row, status: RunStatus) {
    if (canMove(run.status, status))
      this.db.run(
        "UPDATE agent_runs SET status=?,heartbeat=?,finished=? WHERE id=?",
        status,
        now(),
        ["succeeded", "failed", "interrupted"].includes(status) ? now() : null,
        run.id,
      );
  }
  reserve(goal: Row, key: string, instruction: string, thread: string | null) {
    const db = this.db;
    if (
      db.one(
        "SELECT 1 FROM main_tasks WHERE goal_id=? AND mode!='work'",
        goal.id,
      )
    )
      throw new Problem("该委托由工作台直接处理，不启动 Codex。");
    db.allowed(goal.workspace_id);
    if (goal.state !== "active") throw new Problem("请先将目标恢复为进行中");
    if (
      db.one(
        "SELECT id FROM agent_runs WHERE goal_id=? AND finished IS NULL",
        goal.id,
      )
    )
      throw new Problem("该目标已有运行或需要核对的任务", 409);
    const id = uid(),
      stamp = now();
    db.run(
      "INSERT INTO agent_runs VALUES(?,?,?,?,?,'queued',?,?,?,NULL,?)",
      id,
      goal.id,
      goal.provider,
      thread,
      null,
      redact(instruction),
      key,
      stamp,
      stamp,
    );
    this.move(this.run(id), "starting");
    db.run("INSERT INTO main_run_scope VALUES(?,?)", id, goal.constraints_json);
    return this.run(id);
  }
  async start(
    goalId: string,
    key: string,
    instruction?: string,
    continuation = false,
    sourceRun?: string,
  ) {
    const db = this.db,
      goal = this.goal(goalId);
    const existing = db.one(
      "SELECT * FROM agent_runs WHERE goal_id=? AND key=?",
      goalId,
      key,
    );
    if (existing) return existing;
    const previous = sourceRun
      ? db.one(
          "SELECT thread_id FROM agent_runs WHERE goal_id=? AND id=?",
          goalId,
          sourceRun,
        )
      : continuation
        ? db.one(
            "SELECT thread_id FROM agent_runs WHERE goal_id=? AND thread_id IS NOT NULL ORDER BY created DESC LIMIT 1",
            goalId,
          )
        : null;
    if (continuation && !previous) throw new Problem("尚无可以继续的线程");
    const prompt = [
      goal.title,
      goal.description,
      "验收条件",
      ...JSON.parse(goal.criteria),
      "约束",
      ...JSON.parse(goal.constraints_json),
      instruction || "执行目标并报告证据",
    ].join("\n");
    const run = db.tx(() =>
      this.reserve(goal, key, prompt, previous?.thread_id || null),
    );
    try {
      await this.adapters[goal.provider].start(this.context(run));
    } catch (e) {
      const current = this.run(run.id);
      this.event(run.id, {
        key: "start-error",
        type: current.thread_id ? "system.disconnected" : "run.failed",
        title: redact((e as Error).message),
      });
      throw new Problem("启动未完成，请在活动记录查看原因", 503);
    }
    return this.run(run.id);
  }
  event(id: string, e: Observation) {
    const db = this.db;
    const result = db.tx(() => {
      const r = this.run(id),
        fingerprint = createHash("sha256").update(e.key).digest("hex");
      if (
        db.one(
          "SELECT 1 FROM raw_events WHERE run_id=? AND fingerprint=?",
          id,
          fingerprint,
        )
      )
        return;
      const stamp = now(),
        eventId = uid(),
        payload = JSON.stringify(
          Object.fromEntries(
            Object.entries(e.data || {})
              .slice(0, 24)
              .map(([k, v]) => [
                k,
                /secret|token|password|credential|authorization/i.test(k)
                  ? "[已隐藏]"
                  : typeof v === "string"
                    ? redact(v)
                    : typeof v === "object"
                      ? "[已收起]"
                      : v,
              ]),
          ),
        );
      const severity =
        e.type === "run.failed" ||
        e.data?.passed === false ||
        (e.type === "system.reconciled" && e.data?.status === "failed")
          ? "error"
          : e.approval || e.type === "system.disconnected"
            ? "warning"
            : "info";
      db.run(
        "INSERT INTO raw_events(id,run_id,goal_id,fingerprint,type,occurred,received,severity,method,payload,title) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        eventId,
        id,
        r.goal_id,
        fingerprint,
        e.type,
        e.time || stamp,
        stamp,
        severity,
        e.method || e.type,
        payload,
        redact(e.title),
      );
      const event = db.must("SELECT * FROM raw_events WHERE id=?", eventId);
      if (e.approval && !r.finished && r.status !== "unknown") {
        const a = e.approval;
        db.run(
          "INSERT OR IGNORE INTO inbox_items(id,goal_id,run_id,request_id,status,title,action,reason,scope,risk,created,expires,kind,blocking) VALUES(?,?,?,?,'pending',?,?,?,?,?,?,?,?,?)",
          uid(),
          r.goal_id,
          id,
          a.id,
          redact(e.title),
          redact(a.action),
          redact(a.reason),
          redact(a.scope),
          a.risk,
          stamp,
          r.provider === "demo"
            ? null
            : new Date(Date.now() + 3600000).toISOString(),
          a.kind || "approval",
          a.blocking === false ? 0 : 1,
        );
      }
      if (e.type === "provider.request_closed")
        db.run(
          "UPDATE inbox_items SET status='expired',version=version+1 WHERE run_id=? AND request_id=? AND status IN " +
            open,
          id,
          String(e.data?.request),
        );
      const pending = db.one(
        "SELECT 1 FROM inbox_items WHERE run_id=? AND blocking=1 AND status IN " +
          open,
        id,
      );
      const targets: Record<string, RunStatus> = {
        "run.started": "running",
        "approval.requested": "waiting_approval",
        "input.requested": pending ? "waiting_approval" : "running",
        "approval.resolved": pending ? "waiting_approval" : "running",
        "provider.request_closed": pending ? "waiting_approval" : "running",
        "run.completed": "succeeded",
        "run.failed": "failed",
        "run.interrupted": "interrupted",
        "system.disconnected": "unknown",
        "system.reconciled": e.data?.status as RunStatus,
      };
      const target = targets[e.type];
      if (target) this.move(r, target);
      if (
        !r.finished &&
        ["succeeded", "failed", "interrupted", "unknown"].includes(target)
      ) {
        db.run(
          "UPDATE inbox_items SET status='expired',version=version+1 WHERE run_id=? AND kind!='decision' AND status IN " +
            open,
          id,
        );
        if (target !== "unknown")
          db.run(
            "UPDATE inbox_items SET status='resolved',version=version+1 WHERE run_id=? AND kind='decision' AND status IN " +
              open,
            id,
          );
        else if (r.provider === "codex")
          db.run(
            "INSERT OR IGNORE INTO inbox_items(id,goal_id,run_id,request_id,status,title,action,reason,scope,risk,created,kind) VALUES(?,?,?,'local-reconcile','pending','核对失联运行的结果','核实原任务已经结束，再登记终态。','执行连接已断开，自动核对未完成前不会启动下一轮。',?,'需要人工核实',?,'decision')",
            uid(),
            r.goal_id,
            id,
            "本轮运行 " + id,
            stamp,
          );
      }
      db.run("UPDATE goals SET updated=? WHERE id=?", stamp, r.goal_id);
      db.run("UPDATE agent_runs SET heartbeat=? WHERE id=?", stamp, id);
      projectStory(db, r, event, e);
      if (!r.finished && target && this.run(id).finished)
        reportRun(db, r, target, e.title);
      if (e.approval && !r.finished && r.status !== "unknown") {
        const item = db.one(
          "SELECT id FROM inbox_items WHERE run_id=? AND request_id=?",
          id,
          e.approval.id,
        );
        if (item)
          post(
            db,
            "assistant",
            "question",
            `${e.title}\n\n${e.approval.reason}`,
            [r.goal_id],
            "inbox:" + item.id,
          );
      }
      return event;
    });
    if (result) {
      if (
        (["run.completed", "run.failed", "run.interrupted"].includes(e.type) ||
          (e.type === "system.reconciled" && this.run(id).finished)) &&
        db.one(
          "SELECT 1 FROM stories WHERE goal_id=? AND materiality>=0.45",
          result.goal_id,
        )
      )
        generate(db);
      this.bus.emit("event", result);
    }
    return result;
  }
  async decide(id: string, body: unknown) {
    const d = decisionInput.parse(body),
      db = this.db,
      item = this.inbox(id),
      run = this.run(item.run_id);
    const logged = db.one(
      "SELECT * FROM audit_log WHERE target=? AND key=?",
      id,
      d.key,
    );
    if (logged) {
      if (logged.action !== d.decision)
        throw new Problem("幂等键已用于另一决定", 409);
      return item;
    }
    if (
      this.deciding.has(id) ||
      item.version !== d.version ||
      !["pending", "deferred"].includes(item.status)
    )
      throw new Problem("审批状态已变化，请刷新", 409);
    const choices: Record<string, string[]> = {
      approval: ["approve", "deny", "defer"],
      input: ["answer", "defer"],
      decision: ["record", "defer"],
    };
    if (!choices[item.kind].includes(d.decision))
      throw new Problem("决定类型与请求不符");
    if (d.decision === "answer") {
      const questions = JSON.parse(item.action) as { id: string }[];
      if (
        !d.answers ||
        Object.keys(d.answers).length !== questions.length ||
        questions.some((q) => !Object.hasOwn(d.answers!, q.id))
      )
        throw new Problem("请回答每个问题");
    }
    if (
      d.decision === "record" &&
      (!d.observed || !d.note || run.status !== "unknown")
    )
      throw new Problem("请提供核对依据和实际终态");
    if (item.expires && item.expires <= now()) {
      this.expire(item);
      throw new Problem("请求已过期", 409);
    }
    if (d.decision === "approve") {
      db.allowed(this.goal(run.goal_id).workspace_id);
      if (item.risk.includes("仅可拒绝"))
        throw new Problem("无法完整显示请求范围");
    }
    this.deciding.add(id);
    try {
      if (
        d.decision === "approve" ||
        d.decision === "deny" ||
        d.decision === "answer"
      ) {
        try {
          const adapter = this.adapters[run.provider];
          if (d.decision === "answer") {
            if (!adapter.answer) throw Error("unsupported_capability");
            await adapter.answer(run.id, item.request_id, d.answers!);
          } else await adapter.respond(run.id, item.request_id, d.decision);
        } catch {
          this.expire(item);
          throw new Problem("提供方无法接收答复，请核对运行状态", 409);
        }
      }
      db.tx(() => {
        db.run(
          "UPDATE inbox_items SET status=?,version=version+1 WHERE id=?",
          (
            {
              approve: "approved",
              deny: "denied",
              defer: "deferred",
              answer: "resolved",
              record: "resolved",
            } as const
          )[d.decision],
          id,
        );
        db.run(
          "INSERT INTO audit_log(actor,action,target,key,detail,created) VALUES(?,?,?,?,?,?)",
          "user",
          d.decision,
          id,
          d.key,
          JSON.stringify({
            version: d.version,
            run: run.id,
            request: item.request_id,
            note: d.note ? redact(d.note) : undefined,
            observed: d.observed,
          }),
          now(),
        );
      });
      if (d.decision === "record")
        this.event(run.id, {
          key: "manual:" + d.key,
          type: "system.reconciled",
          title:
            d.observed === "failed"
              ? "用户核实本轮运行失败"
              : "用户核实了运行结果",
          data: { status: d.observed, source: "user", note: redact(d.note!) },
        });
      this.event(run.id, {
        key: "decision:" + d.key,
        type:
          d.decision === "defer" ? "approval.deferred" : "approval.resolved",
        title: {
          approve: "已批准本次操作",
          deny: "已拒绝本次操作",
          defer: "审批已稍后处理",
          answer: "已提交补充信息",
          record: "已登记核对结果",
        }[d.decision],
        unit: "approval:" + item.request_id,
        data: { decision: d.decision, item: id },
      });
      return this.inbox(id);
    } finally {
      this.deciding.delete(id);
    }
  }
  expire(item: Row) {
    this.db.run(
      "UPDATE inbox_items SET status='expired',version=version+1 WHERE id=? AND status IN " +
        open,
      item.id,
    );
    this.event(item.run_id, {
      key: "expire:" + item.id,
      type: "approval.expired",
      title: "审批已过期，需要重新核对",
    });
  }
  async reconcile(id: string) {
    const r = this.run(id);
    if (r.status !== "unknown") return r;
    const status = await this.adapters[r.provider].reconcile(this.context(r));
    if (status !== "unknown")
      this.event(id, {
        key: "reconcile:" + status,
        type: "system.reconciled",
        title:
          status === "failed"
            ? "已核对：提供方报告本轮运行失败"
            : "已核对提供方状态",
        data: { status },
      });
    return this.run(id);
  }
  async recover() {
    const db = this.db;
    for (const r of db.all("SELECT * FROM agent_runs WHERE finished IS NULL")) {
      if (
        r.provider === "demo" &&
        r.status === "waiting_approval" &&
        db.one(
          "SELECT 1 FROM inbox_items WHERE run_id=? AND status IN " + open,
          r.id,
        )
      ) {
        let context: Context;
        try {
          context = this.context(r);
        } catch (e) {
          if (!(e instanceof Problem) || e.statusCode !== 422) throw e;
          this.event(r.id, {
            key: "restart:workspace-unavailable",
            type: "run.interrupted",
            unit: "recovery:" + r.id,
            title: "原项目目录不可用，演示已中断，旧审批已失效",
          });
          continue;
        }
        await this.demo.reconcile(context);
        continue;
      }
      if (r.provider === "demo") {
        this.event(r.id, {
          key: "restart",
          type: "run.interrupted",
          title: "演示在重启时中断，可发起新一轮",
        });
        continue;
      }
      this.event(r.id, {
        key: "restart:" + r.status,
        type: "system.disconnected",
        title: "服务重启，需核对上次运行",
      });
      await this.reconcile(r.id).catch(() => {});
    }
  }
  seed() {
    if (this.db.one("SELECT 1 FROM goals")) return;
    const dir = join(this.db.home, "demo-project");
    mkdirSync(dir, { recursive: true });
    const w = this.db.workspace(dir, undefined, false),
      g = this.createGoal({
        title: "开发战棋游戏原型",
        description: "完成可交互的地图、单位移动与寻路验证，准备本地预览。",
        workspaceId: w.id,
        criteria: [
          "can render map",
          "unit movement works",
          "pathfinding tests pass",
        ],
        constraints: ["仅在本机演示环境预览"],
        provider: "demo",
        priority: 4,
      });
    const r = this.reserve(g, "demo-seed", g.description, null),
      c = this.context(r);
    c.reference("demo-thread-" + r.id, "demo-turn-" + r.id);
    this.demo.sessions.set(r.id, c);
    c.emit({ key: "start", type: "run.started", title: "演示任务已启动" });
    fixture.forEach(c.emit);
    generate(this.db);
  }
  close() {
    this.closed = true;
    Object.values(this.adapters).forEach((a) => a.close());
    this.db.close();
  }
}
