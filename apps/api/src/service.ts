import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { DirectoryUnavailable, Store, now, uid, Problem, type Row } from "./db.ts";
import { holdDirectory, pendingDirectory } from "./directory-recovery.ts";
import { followupInstruction } from "./followups.ts";
import { recordChoice, recordUsage } from "./usage.ts";
import { deliverUpdate, reportRun, post } from "./main-conversation.ts";
import {
  type AgentAdapter,
  ApprovalScopeChanged,
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

// Direct API calls and older queued messages may have no interpreter assessment.
function classifyWork(request: string) {
  if (/排查|根因|跨模块|架构|迁移|并发|诊断|root cause|diagnos|debug|architect|migration|race condition/i.test(request)) return "deep";
  if (/^(?:请|帮我|please )?(?:摘要|总结|翻译|提取|归类|summari[sz]e|translate|extract)/i.test(request.trim())) return "light";
  return "standard";
}

const open = "('pending','deferred')";
type ApprovalGrant = { source: string; actor: "goal_grant" | "run_grant" };
export class Service {
  db: Store;
  bus = new EventEmitter();
  closed = false;
  deciding = new Set<string>();
  // A live run may reuse one explicit grant. A restarted or disconnected
  // execution must obtain a new one. The decision history stays in SQLite.
  private runGrants = new Map<string, string>();
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
    this.db.allowed(input.workspaceId);
    return this.insertGoal(input);
  }
  private insertGoal(input: GoalInput) {
    const g = goalInput.parse(input);
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
    // The queue retains work for an enabled project even if its folder moved
    // before intake. Dispatch checks the actual location before starting.
    this.db.enabledWorkspace(workspaceId!);
    const g = this.insertGoal({
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
    const baseline = run.thread_id
      ? this.db.one("SELECT total FROM token_usage WHERE source=?", "thread:" + run.thread_id)?.total
      : 0;
    return {
      id: run.id,
      workspace,
      imageUrls: this.db.all(`SELECT i.mime,i.bytes FROM conversation_images i
        JOIN user_messages u ON u.id=i.message_id WHERE u.id=? AND u.goal_id=? ORDER BY i.position`, run.key, goal.id)
        .map(i => "data:" + i.mime + ";base64," + Buffer.from(i.bytes).toString("base64")),
      managedCommission: !!this.db.one(
        "SELECT 1 FROM managed_commissions WHERE goal_id=? AND workspace_id=?",
        goal.id,
        goal.workspace_id,
      ),
      instruction: run.instruction + followupInstruction(this.db, run.goal_id, run.key),
      thread: run.thread_id,
      turn: run.turn_id,
      threadUsage: (thread, counts) => {
        if (!this.closed) this.db.tx(() => {
          recordUsage(this.db, "thread:" + thread, goal.id, counts);
          if (baseline != null) this.db.run(
            "UPDATE model_calls SET total=(SELECT total-? FROM token_usage WHERE source=? AND total>=?) WHERE source=?",
            baseline, "thread:" + thread, baseline, run.id);
        });
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
    if (goal.state !== "active") throw new Problem("请先将目标恢复为进行中");
    if (
      db.one(
        "SELECT id FROM agent_runs WHERE goal_id=? AND finished IS NULL",
        goal.id,
      )
    )
      throw new Problem("该目标已有运行或需要核对的任务", 409);
    if (pendingDirectory(db, goal.id))
      throw new Problem("请先在主对话中确认这项委托的项目目录。", 409);
    db.allowed(goal.workspace_id);
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
    origin: "request" | "queue" | "schedule" = "request",
  ) {
    const db = this.db,
      goal = this.goal(goalId);
    const existing = db.one(
      "SELECT * FROM agent_runs WHERE goal_id=? AND key=?",
      goalId,
      key,
    );
    if (existing) return existing;
    const message =
      origin === "schedule"
        ? undefined
        : db.one(
            "SELECT goal_id,content,source_run,workload FROM user_messages WHERE id=?",
            key,
          );
    const request = instruction || "执行目标并报告证据";
    if (
      origin === "request" &&
      message &&
      (message.goal_id !== goalId || message.content !== redact(request))
    )
      throw new Problem("提交编号已用于其他指令", 409);
    const previous = message?.source_run
      ? db.one(
          "SELECT id,thread_id FROM agent_runs WHERE goal_id=? AND id=?",
          goalId,
          message.source_run,
        )
      : continuation
        ? db.one(
            "SELECT id,thread_id FROM agent_runs WHERE goal_id=? AND thread_id IS NOT NULL ORDER BY created DESC LIMIT 1",
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
      request,
    ].join("\n");
    let run: Row, context: Context;
    try {
      ({ run, context } = db.tx(() => {
        const run = this.reserve(
          goal,
          key,
          prompt,
          previous?.thread_id || null,
        );
        return { run, context: this.context(run) };
      }));
    } catch (e) {
      if (e instanceof DirectoryUnavailable) {
        db.tx(() => {
          // Direct starts have no outbox or schedule to come back to.
          if (origin === "request" && !message)
            db.run(
              "INSERT INTO user_messages(id,goal_id,scope,ref,content,created,status,source_run) VALUES(?,?,'goal',?,?,?,'queued',?)",
              key,
              goal.id,
              goal.id,
              redact(request),
              now(),
              previous?.id ?? null,
            );
          holdDirectory(db, goal, e.message);
        });
      }
      throw e;
    }
    try {
      if (goal.provider === "codex") {
        const continuing = previous && (message?.source_run || !instruction || /^(继续|接着做|continue)[。.!！]?$/i.test(request.trim()));
        const inherited = continuing ? db.one("SELECT workload FROM model_calls WHERE source=?", previous.id)?.workload : null;
        const workload = message?.workload ?? inherited ?? classifyWork(instruction || goal.description);
        context.workload = workload;
        context.selection = choice => {
          if (!this.closed) recordChoice(db, run.id, "委托执行", workload, choice);
        };
      }
      await this.adapters[goal.provider].start(context);
    } catch (e) {
      const current = this.run(run.id);
      if (!current.finished) this.event(run.id, {
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
          "INSERT OR IGNORE INTO inbox_items(id,goal_id,run_id,request_id,status,title,action,reason,scope,risk,created,expires,kind,blocking,allow_for_run,masked_command) VALUES(?,?,?,?,'pending',?,?,?,?,?,?,?,?,?,?,?)",
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
          Number(
            !!a.allowForRun &&
              r.provider === "codex" &&
              (a.kind ?? "approval") === "approval",
          ),
          Number(
            !!a.maskedCommand &&
              r.provider === "codex" &&
              (a.kind ?? "approval") === "approval",
          ),
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
      if (e.type === "agent.message" && e.data?.delivery === "async") deliverUpdate(db, r, event);
      if (!r.finished && target && this.run(id).finished)
        reportRun(db, r, target, e.title);
      if (e.approval && !r.finished && r.status !== "unknown") {
        const item = db.one(
          "SELECT * FROM inbox_items WHERE run_id=? AND request_id=?",
          id,
          e.approval.id,
        );
        if (item?.status === "pending" && !this.approvalGrant(item))
          this.askAbout(item);
      }
      return event;
    });
    if (result) {
      if (this.runGrants.has(id)) {
        const current = this.run(id);
        if (current.finished || current.status === "unknown") this.runGrants.delete(id);
      }
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
  private askAbout(item: Row) {
    post(
      this.db, "assistant", "question", `${item.title}\n\n${item.reason}`,
      [item.goal_id], "inbox:" + item.id,
    );
  }
  goalGrant(goalId: string): string | null {
    return (
      this.db.one(
        "SELECT source FROM active_goal_approval_grants WHERE goal_id=?",
        goalId,
      )?.source ?? null
    );
  }
  maskedCommandGrant(goalId: string): string | null {
    return (
      this.db.one(
        "SELECT source FROM active_masked_command_grants WHERE goal_id=?",
        goalId,
      )?.source ?? null
    );
  }
  private approvalGrant(item: Row): ApprovalGrant | undefined {
    if (item.masked_command) {
      const source = this.maskedCommandGrant(item.goal_id);
      return source ? { source, actor: "goal_grant" } : undefined;
    }
    if (!item.allow_for_run) return;
    const source = this.goalGrant(item.goal_id);
    if (source) return { source, actor: "goal_grant" };
    const run = this.runGrants.get(item.run_id);
    if (run) return { source: run, actor: "run_grant" };
  }
  revokeGoalGrant(goalId: string, source: string) {
    const db = this.db;
    this.goal(goalId);
    return db.tx(() => {
      const current = db.one("SELECT source FROM goal_approval_grants WHERE goal_id=?", goalId)?.source;
      if (current && current !== source) throw new Problem("委托授权已更换，请刷新后重试。", 409);
      if (current) {
        db.run("DELETE FROM goal_approval_grants WHERE goal_id=? AND source=?", goalId, source);
        db.run("INSERT INTO audit_log(actor,action,target,detail,created) VALUES('user','revoke_goal',?,?,?)",
          source, JSON.stringify({ goal: goalId }), now());
        const live = db.one("SELECT id FROM agent_runs WHERE goal_id=? AND finished IS NULL", goalId);
        if (live) this.runGrants.delete(live.id);
      }
      return { id: goalId };
    });
  }
  async applyApprovalGrants() {
    const pending = this.db.all(
      `SELECT i.id,i.goal_id,i.run_id,i.version,i.allow_for_run,i.masked_command,
        EXISTS(SELECT 1 FROM main_messages WHERE origin='inbox:'||i.id) asked
       FROM inbox_items i WHERE i.status='pending' AND (i.allow_for_run=1 OR i.masked_command=1) ORDER BY i.created,i.rowid`,
    );
    for (const item of pending) {
      if (this.deciding.has(item.id)) continue;
      const grant = this.approvalGrant(item);
      if (!grant && item.asked) continue;
      if (grant) {
        try {
          await this.decide(item.id, { decision: "approve", key: uid(), version: item.version }, grant);
          continue;
        } catch (e) {
          if (!(e instanceof Problem)) throw e;
        }
      }
      // A grant may have been revoked after suppressing this question.
      const current = this.inbox(item.id);
      if (current.status === "pending" &&
          !this.db.one("SELECT 1 FROM main_messages WHERE origin=?", "inbox:" + current.id))
        this.db.tx(() => this.askAbout(current));
    }
  }
  reviewCommand(id: string, version: number) {
    const item = this.inbox(id),
      run = this.run(item.run_id),
      goal = this.goal(item.goal_id);
    if (
      !item.masked_command ||
      !["pending", "deferred"].includes(item.status) ||
      item.version !== version ||
      (item.expires && item.expires <= now()) ||
      run.finished ||
      run.status === "unknown" ||
      item.scope !== this.db.allowed(goal.workspace_id) ||
      goal.state !== "active"
    )
      throw new Problem("这条命令已无法核对，请刷新审批页", 409);
    const review = this.adapters[run.provider].reviewCommand?.(
      run.id,
      item.request_id,
      version,
    );
    if (!review) throw new Problem("原请求已失效或目录已改变", 409);
    return review;
  }
  async decide(id: string, body: unknown, grant?: ApprovalGrant) {
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
      approval: ["approve", "approve_run", "approve_goal", "deny", "defer"],
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
    const newRunGrant = d.decision === "approve_run" && !this.goalGrant(run.goal_id);
    const approving = d.decision === "approve" || d.decision === "approve_run" || d.decision === "approve_goal";
    if (approving) {
      const goal = this.goal(run.goal_id);
      const workspace = db.allowed(goal.workspace_id);
      if (item.risk.includes("仅可拒绝"))
        throw new Problem("无法完整显示请求范围");
      if (item.masked_command && !grant) {
        if (
          d.decision === "approve_run" ||
          !d.reviewKey ||
          this.reviewCommand(id, d.version).reviewKey !== d.reviewKey
        )
          throw new Problem("请先在本机查看这条完整命令", 409);
      }
      if (d.decision !== "approve" || grant) {
        if (
          !(item.allow_for_run || item.masked_command) ||
          item.scope !== workspace ||
          goal.state !== "active" ||
          run.finished ||
          run.status === "unknown" ||
          (grant && this.approvalGrant(item)?.source !== grant.source)
        )
          throw new Problem("这项请求当前不能使用持续授权。", 409);
      }
      // Reserve the original scope before yielding to the provider. A project
      // switch or withdrawal during the reply must not recreate consent.
      if (d.decision === "approve_goal")
        db.tx(() => {
          if (!this.goalGrant(goal.id)) {
            const saved = db.run(
              "INSERT INTO goal_approval_grants(goal_id,workspace_id,source) VALUES(?,?,?) ON CONFLICT(goal_id) DO NOTHING",
              goal.id,
              goal.workspace_id,
              id,
            );
            if (!saved.changes)
              throw new Problem("这项委托的授权正在处理，请稍后重试。", 409);
          }
          if (item.masked_command && !this.maskedCommandGrant(goal.id)) {
            const saved = db.run(
              "INSERT INTO masked_command_grants(goal_id,source) VALUES(?,?) ON CONFLICT(goal_id) DO NOTHING",
              goal.id,
              id,
            );
            if (!saved.changes)
              throw new Problem("这项委托的授权正在处理，请稍后重试。", 409);
          }
        });
    }
    this.deciding.add(id);
    try {
      if (
        approving ||
        d.decision === "deny" ||
        d.decision === "answer"
      ) {
        try {
          const adapter = this.adapters[run.provider];
          if (d.decision === "answer") {
            if (!adapter.answer) throw Error("unsupported_capability");
            await adapter.answer(run.id, item.request_id, d.answers!);
          } else
            await adapter.respond(
              run.id,
              item.request_id,
              approving ? "approve" : "deny",
              !!item.masked_command && approving,
            );
        } catch (error) {
          if (error instanceof ApprovalScopeChanged) {
            db.run(
              "UPDATE inbox_items SET allow_for_run=0,masked_command=0,risk=?,version=version+1 WHERE id=? AND status IN " +
                open,
              error.message,
              id,
            );
            throw new Problem(error.message, 409);
          }
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
              approve_run: "approved",
              approve_goal: "approved",
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
          grant?.actor ?? "user",
          d.decision,
          id,
          d.key,
          JSON.stringify({
            version: d.version,
            run: run.id,
            request: item.request_id,
            grant: grant?.source,
            note: d.note ? redact(d.note) : undefined,
            observed: d.observed,
          }),
          now(),
        );
      });
      if (d.decision === "approve_goal") this.runGrants.delete(run.id);
      if (newRunGrant && !this.goalGrant(run.goal_id)) {
        const current = this.run(run.id);
        if (!current.finished && current.status !== "unknown") this.runGrants.set(run.id, id);
      }
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
          approve: grant?.actor === "goal_grant" ? "已按委托授权允许操作" : grant ? "已按本轮授权允许操作" : "已批准本次操作",
          approve_run: "已允许本轮后续命令和文件修改",
          approve_goal: "已批准本次操作并选择委托授权",
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
      if (d.decision === "approve_goal") {
        db.run(
          "DELETE FROM masked_command_grants WHERE source=? AND NOT EXISTS(SELECT 1 FROM active_masked_command_grants WHERE source=?)",
          id,
          id,
        );
        db.run(
          "DELETE FROM goal_approval_grants WHERE source=? AND NOT EXISTS(SELECT 1 FROM active_goal_approval_grants WHERE source=?)",
          id,
          id,
        );
      }
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
    db.run("UPDATE model_calls SET outcome='unknown' WHERE source LIKE 'exec:%' AND outcome='running'");
    db.run(
      "DELETE FROM goal_approval_grants WHERE source NOT IN (SELECT source FROM active_goal_approval_grants)",
    );
    db.run(
      "DELETE FROM masked_command_grants WHERE source NOT IN (SELECT source FROM active_masked_command_grants)",
    );
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
