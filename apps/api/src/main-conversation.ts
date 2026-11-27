import { z } from "zod";
import { post } from "./main-messages.ts";
import { pendingDirectory, releaseDirectory } from "./directory-recovery.ts";
import { followupFor, waitingFor, answerFollowup } from "./followups.ts";
import { execMeter } from "./usage.ts";
import {
  DirectoryUnavailable,
  now,
  uid,
  Problem,
  type Row,
  type Store,
} from "./db.ts";
import type { Service } from "./service.ts";
import {
  action,
  interpret,
  type Intent,
  type Interpret,
} from "./main-model.ts";
import { redact } from "../../../packages/agent-core/src/index.ts";
export { post } from "./main-messages.ts";

export const sendInput = z
  .object({
    key: z.string().uuid(),
    text: z.string().trim().min(1).max(4000),
    replyTo: z.string().uuid().optional(),
    focus: z.string().uuid().optional(),
  })
  .strict();
export const projectDecision = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("select"),
      workspaceId: z.string().uuid(),
      enable: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("authorize"),
      name: z.string().trim().min(1).max(160).optional(),
      path: z.string().trim().min(1).max(4000),
    })
    .strict(),
  z.object({ kind: z.literal("cancel") }).strict(),
  z.object({ kind: z.literal("independent") }).strict(),
]);
type ProjectDecision = z.infer<typeof projectDecision>;
type Send = z.infer<typeof sendInput>;
export const stamp = (date: string) =>
  new Date(date).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
export function timeline(db: Store, before = Number.MAX_SAFE_INTEGER, changed?: string[]): Row[] {
  return db
    .all(
      `WITH notices AS (
        SELECT m.seq,i.goal_id,i.status FROM inbox_items i
        JOIN main_messages m ON m.origin='inbox:'||i.id WHERE i.kind='approval'
      ), groups AS (
        SELECT goal_id,max(seq) latest,count(*) total,
          sum(status IN ('pending','deferred')) pending,
          min(CASE WHEN status IN ('pending','deferred') THEN seq END) first_pending
        FROM notices GROUP BY goal_id
      )
      SELECT m.*, a.goal_id approvalGoal,a.total approvalTotal,a.pending approvalPending,
      CASE WHEN original.id IS NOT NULL THEN json_object(
        'type','message','id',original.id,'role',original.role,'kind',original.kind,'created',original.created,
        'text',substr(original.body,1,240),'origin',original.origin)
        WHEN selected.id IS NOT NULL THEN json_object('type','goal','id',selected.id,'text',selected.title)
      END quote,
      substr(p.origin,7) nextApproval, json_extract(q.intent,'$.project') project, coalesce(q.resolved_by,h.resolved_by) resolvedBy,
      h.resolved_at directoryResolvedAt,
      w.path directoryPath, (g.state='active' AND w.enabled=1) canRecover,
      coalesce((SELECT json_group_array(json_object('id',g.id,'title',g.title)) FROM goals g JOIN main_refs r ON r.goal_id=g.id WHERE r.message_id=m.id),'[]') refs
    FROM main_messages m LEFT JOIN main_project_questions q ON q.message_id=m.id
    LEFT JOIN main_messages original ON m.role='user' AND original.id=m.reply_to
    LEFT JOIN goals selected ON selected.id=m.reply_goal
    LEFT JOIN directory_holds h ON h.notice_id=m.id LEFT JOIN workspaces w ON w.id=h.workspace_id
    LEFT JOIN goals g ON g.id=h.goal_id
    LEFT JOIN notices n ON n.seq=m.seq LEFT JOIN groups a ON a.goal_id=n.goal_id
    LEFT JOIN main_messages p ON p.seq=a.first_pending
    WHERE m.seq<? AND (n.seq IS NULL OR m.seq=a.latest) ${changed ? `AND m.seq IN (
        SELECT coalesce(a.latest, changed.seq) FROM main_messages changed
        LEFT JOIN notices n ON n.seq=changed.seq LEFT JOIN groups a ON a.goal_id=n.goal_id
        WHERE changed.id IN (SELECT value FROM json_each(?)))` : ""}
      ORDER BY m.seq DESC LIMIT 80`,
      before,
      ...(changed ? [JSON.stringify(changed)] : []),
    )
    .reverse()
    .map((m) => ({ ...m, quote: m.quote && JSON.parse(m.quote), refs: JSON.parse(m.refs) }));
}
export function reportRun(db: Store, r: Row, type: string, title: string) {
  const g = db.must("SELECT * FROM goals WHERE id=?", r.goal_id);
  // Only new terminal events create conversation messages, never a replay of old history.
  if (g.state === "paused" || g.state === "archived") return;
  const scope = db.one(
    "SELECT constraints_json FROM main_run_scope WHERE run_id=?",
    r.id,
  );
  if (
    type === "succeeded" &&
    scope &&
    scope.constraints_json !== g.constraints_json
  )
    return;
  if (type === "succeeded" || type === "failed" || type === "interrupted") {
    const last = db.one(
      "SELECT title,json_extract(payload,'$.followup') question FROM raw_events WHERE run_id=? AND type='agent.message' ORDER BY seq DESC LIMIT 1",
      r.id,
    );
    const question = type === "succeeded" && last?.question;
    const body = type === "succeeded"
      ? last?.title || "本轮已结束，没有可阅读的回复。"
      : `本轮${type === "interrupted" ? "已中断" : "未完成"}：${title}`;
    const id = post(
      db,
      "assistant",
      question ? "question" : type === "succeeded" ? "result" : "problem",
      question && !body.includes(question) ? body + "\n\n" + question : body,
      [g.id],
      "run:" + r.id,
    );
    if (question)
      db.run("INSERT OR IGNORE INTO followup_questions(message_id,run_id,question) VALUES(?,?,?)", id, r.id, question);
  }
}
export function nextSlot(cadence: string, clock: string, from: Date) {
  const d = new Date(from);
  const [h, m] = clock.split(":").map(Number);
  d.setHours(h, m, 0, 0);
  if (d <= from) d.setDate(d.getDate() + 1);
  if (cadence === "weekdays")
    while ([0, 6].includes(d.getDay())) d.setDate(d.getDate() + 1);
  return d.toISOString();
}
function when(a: Intent, instant: Date) {
  if (!a.at) {
    if (a.type === "reminder" || a.type === "reschedule")
      throw new Problem("还缺少明确的提醒时间。");
    return {
      next: a.cadence === "once" ? null : nextSlot(a.cadence, "09:00", instant),
      clock: "09:00",
    };
  }
  if (!/^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d$/.test(a.at))
    throw new Problem("无法确定本地执行时间，请补充日期和时间。");
  const d = new Date(a.at);
  const clock = a.at.slice(-5);
  if (!Number.isFinite(+d) || d.getDate() !== Number(a.at.slice(8, 10)))
    throw new Problem("日期无效。");
  if (d <= instant && a.cadence === "once")
    throw new Problem("该时间已过，请指定下次执行时间。");
  return {
    next: d <= instant ? nextSlot(a.cadence, clock, instant) : d.toISOString(),
    clock,
  };
}
const labels: Record<string, string> = {
  succeeded: "上一轮已结束",
  failed: "上一轮未完成",
  unknown: "失联，等待核对",
  interrupted: "上一轮中断",
  running: "执行中",
  starting: "启动中",
  waiting_approval: "正在等你的决定",
  queued: "等待执行",
  paused: "已暂停",
  completed: "已完成",
  archived: "已归档",
  blocked: "受阻",
};
export function progress(db: Store, g: Row) {
  const hold = pendingDirectory(db, g.id);
  if (hold) {
    const enabled = db.must(
      "SELECT enabled FROM workspaces WHERE id=?",
      g.workspace_id,
    ).enabled;
    const next =
      g.state !== "active"
        ? labels[g.state] || g.state
        : !enabled
          ? "项目已停用，需要先在设置中重新启用"
          : "恢复原目录后会自动继续，也可以在主对话的提醒里确认新位置";
    return `${g.title}：本次工作尚未开始，${hold.reason}。${next}。`;
  }
  const t = db.one("SELECT * FROM main_tasks WHERE goal_id=?", g.id);
  const r = db.one(
    "SELECT * FROM agent_runs WHERE goal_id=? ORDER BY created DESC,rowid DESC LIMIT 1",
    g.id,
  );
  const next =
    t?.next_at ||
    db.one(
      "SELECT min(next_at) t FROM schedule_jobs WHERE goal_id=? AND state='enabled'",
      g.id,
    )?.t;
  const disabled = !db.must(
    "SELECT enabled FROM workspaces WHERE id=?",
    g.workspace_id,
  ).enabled;
  const facts = [labels[g.state], t?.last_note];
  if (disabled)
    facts.push("项目已停用，在设置的「已授权项目」重新启用后可继续执行");
  if (t?.mode === "trending") {
    if (t.attempted) facts.push("上次尝试 " + stamp(t.attempted));
    facts.push(
      t.succeeded ? "最近成功读取 " + stamp(t.succeeded) : "尚无成功读取记录",
    );
  } else if (
    g.state === "active" &&
    !disabled &&
    (!r || r.finished) &&
    db.one(
      "SELECT 1 FROM user_messages WHERE goal_id=? AND status IN ('queued','dispatching')",
      g.id,
    )
  ) {
    facts.push("本次工作已排队，等待开始");
  } else if (r) {
    const waiting = r.finished && !disabled && g.state === "active" && waitingFor(db, r.id);
    if (waiting)
      return g.title + "：" + (waiting.last_answer ? "已收到「" + String(waiting.last_answer).slice(0, 140) + "」。" : "") +
        "正在等你补充：" + waiting.question;
    facts.push(labels[r.status] || r.status);
    const e = db.one(
      "SELECT title FROM raw_events WHERE run_id=? AND type IN ('agent.message','run.failed','system.disconnected','approval.requested','input.requested') ORDER BY seq DESC LIMIT 1",
      r.id,
    );
    if (e) facts.push(String(e.title).replace(/\s+/g, " ").slice(0, 140));
  } else if (!t?.last_note)
    facts.push(t?.mode === "reminder" ? "提醒已登记" : "尚无执行记录");
  if (g.state === "active" && !disabled && next)
    facts.push("下次 " + stamp(next));
  return `${g.title}：${facts.filter(Boolean).join("；")}。`;
}

const sameName = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

export class MainConversation {
  s: Service;
  route: Interpret;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(s: Service, route: Interpret = interpret) {
    this.s = s;
    this.route = route;
  }
  send(input: Send) {
    const task = this.tail.then(() => this.handle(input));
    this.tail = task.catch(() => {});
    return task;
  }
  async drain() {
    await this.tail;
  }
  private accept(a: Intent, instant: Date, project?: Row) {
    const { db } = this.s;
    const { next, clock } = when(a, instant),
      immediate = a.type === "work" && !a.at;
    const g = this.s.createCommission(a.text, uid(), project?.id, immediate);
    db.run(
      "INSERT INTO main_tasks(goal_id,mode,cadence,clock,next_at,notify) VALUES(?,?,?,?,?,?)",
      g.id,
      a.type,
      a.cadence,
      clock,
      a.type === "trending" && !a.at ? instant.toISOString() : next,
      a.notify,
    );
    const answer = `已接下「${g.title}」。${project ? `将在「${project.name}」中工作。` : ""}${a.type === "trending" ? (a.notify === "changes" ? "只在有符合要求的新项目时告诉你。" : "按约定给你一份热榜结果。") : immediate ? "已排队执行。" : ""}${next ? `下次${a.type === "reminder" ? "提醒" : "执行"}：${stamp(next)}${a.cadence === "weekdays" ? "（工作日）" : a.cadence === "daily" ? "（每天）" : ""}。` : ""}`;
    return { goal: g.id as string, answer };
  }
  resolveProject(id: string, decision: ProjectDecision, reply?: Send) {
    const { db } = this.s;
    return db.tx(() => {
      const q = db.must(
        "SELECT * FROM main_project_questions WHERE message_id=?",
        id,
      );
      if (q.resolved_by) {
        if (q.decision !== JSON.stringify(decision))
          throw new Problem("这项委托的项目选择已处理，请查看最新回复。", 409);
        return { id: q.resolved_by as string };
      }
      const a = action.parse(JSON.parse(q.intent));
      let project: Row | undefined;
      if (decision.kind === "authorize") {
        project = db.workspace(decision.path, decision.name);
      } else if (decision.kind === "select") {
        project = db.projects().find((p) => p.id === decision.workspaceId);
        if (!project) throw new Problem("请选择已授权项目。");
        if (!project.enabled && !decision.enable)
          throw new Problem("项目已停用，请确认重新启用。");
        if (!project.enabled)
          db.run("UPDATE workspaces SET enabled=1 WHERE id=?", project.id);
      }
      const created =
        decision.kind !== "cancel"
          ? this.accept(a, new Date(q.asked_at), project)
          : null;
      const refs = created ? [created.goal] : [];
      const user = post(
        db,
        "user",
        "message",
        reply
          ? redact(reply.text)
          : project
            ? `使用项目「${project.name}」`
            : created
              ? "作为独立委托处理"
              : "取消这项委托",
        refs,
        "project-answer:" + id,
        reply ? reply.replyTo || null : id,
        reply?.key || uid(),
        reply?.focus ?? null,
      );
      if (created)
        db.run("INSERT INTO main_refs VALUES(?,?)", q.request_id, created.goal);
      post(
        db,
        "assistant",
        "ack",
        created?.answer || `已取消「${a.text}」。`,
        refs,
        "ack:" + user,
        user,
      );
      db.run(
        "UPDATE main_project_questions SET resolved_by=?,decision=? WHERE message_id=?",
        user,
        JSON.stringify(decision),
        id,
      );
      return { id: user };
    });
  }
  resolveDirectory(id: string, path?: string, reply?: Send) {
    const { db } = this.s;
    return db.tx(() => {
      const hold = db.must(
        "SELECT * FROM directory_holds WHERE notice_id=?",
        id,
      );
      if (hold.resolved_at) {
        if (path && path !== hold.replacement_path)
          throw new Problem("这次目录变更已处理，请查看当前委托。", 409);
        if (!reply) return { id: hold.resolved_by ?? id };
      }
      const refs = [hold.goal_id];
      const key = reply?.key ?? uid();
      const user = post(
        db,
        "user",
        "message",
        reply
          ? redact(reply.text)
          : path
            ? `为这项委托确认新位置：${path}`
            : "原目录已恢复，继续",
        refs,
        "in:" + key,
        reply ? (reply.replyTo ?? null) : id,
        key,
        reply?.focus ?? null,
      );
      let answer: string;
      try {
        answer = hold.resolved_at
          ? `这次目录问题已处理。${progress(db, this.s.goal(hold.goal_id))}`
          : releaseDirectory(db, hold, user, path);
      } catch (e) {
        if (!reply || path || !(e instanceof DirectoryUnavailable)) throw e;
        answer = `${e.message}，本次工作仍在等原目录恢复。也可以在提醒里确认新位置。`;
      }
      post(db, "assistant", "ack", answer, refs, "ack:" + user, user);
      return { id: user };
    });
  }
  async handle(b: Send) {
    const { db } = this.s,
      text = redact(b.text);
    const previous = db.one("SELECT * FROM main_messages WHERE id=?", b.key);
    if (previous) {
      if (
        previous.role !== "user" ||
        previous.body !== text ||
        previous.reply_to !== (b.replyTo || null) ||
        (previous.reply_goal && previous.reply_goal !== b.focus)
      )
        throw new Problem("消息编号冲突", 409);
      return { id: b.key };
    }
    const reply = b.replyTo
      ? db.must("SELECT * FROM main_messages WHERE id=?", b.replyTo)
      : undefined;
    if (b.focus) this.s.goal(b.focus);
    // A bare project name can answer the last request only when it has a
    // single open question. Explicit replies also work after other messages.
    const pending = b.replyTo
      ? db.all(
          "SELECT * FROM main_project_questions WHERE message_id=?",
          b.replyTo,
        )
      : !b.focus
        ? db.all(`SELECT * FROM main_project_questions WHERE resolved_by IS NULL AND
          request_id=(SELECT id FROM main_messages WHERE role='user' ORDER BY seq DESC LIMIT 1)`)
        : [];
    if (pending.length === 1) {
      const question = pending[0];
      if (question.resolved_by)
        throw new Problem("项目已确定，请回复接单消息。", 409);
      const name = text
        .replace(/^(?:使用|选择|用)\s*/, "")
        .replace(/[。！!]$/, "")
        .trim();
      const matches = db.projects().filter((p) => sameName(p.name, name));
      if (matches.length === 1 && matches[0].enabled)
        return this.resolveProject(
          question.message_id,
          { kind: "select", workspaceId: matches[0].id },
          b,
        );
      if (/^(独立执行|作为独立委托处理)$/.test(text))
        return this.resolveProject(
          question.message_id,
          { kind: "independent" },
          b,
        );
      if (/^(取消这项委托|取消)$/.test(text))
        return this.resolveProject(question.message_id, { kind: "cancel" }, b);
      if (b.replyTo)
        throw new Problem("请在这条问题下确认项目，或回复已启用的项目名称。");
    }
    const goals = db.all(
      `SELECT g.id,g.title,g.state,g.updated,h.notice_id directoryNotice FROM goals g
       LEFT JOIN directory_holds h ON h.goal_id=g.id AND h.resolved_at IS NULL ORDER BY g.updated DESC`,
    );
    const recent = db
      .all(
        "SELECT id,role,kind,substr(body,1,400) body,created FROM main_messages WHERE kind IN('message','ack','question','status','answer','directory') ORDER BY seq DESC LIMIT 8",
      )
      .reverse();
    const last = recent.at(-1);
    const refs = (id: string) =>
      db
        .all("SELECT goal_id FROM main_refs WHERE message_id=?", id)
        .map((r) => r.goal_id as string);
    // Read the actual last message: the abbreviated routing history omits results.
    const latest = reply ?? db.one("SELECT * FROM main_messages ORDER BY seq DESC LIMIT 1");
    const bound = b.replyTo ? refs(b.replyTo) : b.focus ? [b.focus] : [];
    let questionMessage = reply ?? (latest?.kind === "question" ? latest : undefined);
    const statusGoals = latest?.kind === "status" ? refs(latest.id) : [];
    const questionGoal = !b.replyTo && b.focus ? b.focus : statusGoals.length === 1 ? statusGoals[0] : undefined;
    if (questionGoal && (!reply || reply.kind === "status"))
      questionMessage = db.one(`SELECT m.* FROM main_messages m JOIN followup_questions f ON f.message_id=m.id
        WHERE f.answer_id IS NULL AND f.run_id=(SELECT id FROM agent_runs WHERE goal_id=? ORDER BY created DESC,rowid DESC LIMIT 1)`, questionGoal);
    const candidate = questionMessage && followupFor(db, questionMessage);
    const followup = b.focus && b.focus !== candidate?.goal ? undefined : candidate;
    const fresh = last && Date.now() - Date.parse(last.created) < 10 * 60_000;
    const focus =
      bound.length === 1
        ? bound[0]
        : followup ? followup.goal : !b.replyTo &&
            fresh &&
            (last.kind === "ack" || last.kind === "directory") &&
            refs(last.id).length === 1
          ? refs(last.id)[0]
          : "";
    const instant = new Date();
    // Accept a replacement path only from an explicit reply to its notice.
    // Model output cannot choose a new filesystem location.
    const newLocation =
      reply?.kind === "directory" &&
      /^(?:请)?(?:改用|确认新位置(?:为|是)?)\s*[:：]?\s*(\/[^\n]+)$/.exec(
        b.text,
      );
    if (newLocation && reply)
      return this.resolveDirectory(reply.id, newLocation[1].trim(), b);
    let directoryChoices: Row[] = [];
    if (
      /^(?:请|那就|现在)?(?:(?:原)?目录(?:已恢复|恢复了)[，, ]*)?(?:继续(?:执行|工作|吧)?|接着做)[。！!\s]*$/.test(
        text,
      )
    ) {
      if (reply?.kind === "directory")
        return this.resolveDirectory(reply.id, undefined, b);
      // A directed reply or a recent exchange about one goal has a known
      // target. With several outstanding notices, a bare “continue” needs a name.
      const recentTargets =
        fresh && last.kind !== "directory" ? refs(last.id) : [];
      const targets =
        b.replyTo || b.focus
          ? bound
          : recentTargets.length === 1
            ? recentTargets
            : null;
      const candidates = goals.filter(
        (g) => g.state === "active" && (!targets || targets.includes(g.id)),
      );
      directoryChoices = candidates.filter((g) => g.directoryNotice);
      if (directoryChoices.length === 1)
        return this.resolveDirectory(
          directoryChoices[0].directoryNotice,
          undefined,
          b,
        );
      if (!directoryChoices.length) {
        if (!targets && fresh && last.kind === "directory")
          return this.resolveDirectory(last.id, undefined, b);
        if (candidates.length === 1) {
          const prior = db.one(
            "SELECT notice_id FROM directory_holds WHERE goal_id=? AND resolved_at IS NOT NULL ORDER BY resolved_at DESC LIMIT 1",
            candidates[0].id,
          );
          if (prior)
            return this.resolveDirectory(prior.notice_id, undefined, b);
        }
      }
    }
    const generic =
      /^(?:那|现在|目前|最近|都|总体|全部|这些委托|进度|任务|我的委托|请问|了|呢|的|如何|情况|怎么样|到哪一步|安排好了吗|进展|有什么|怎样|[？?！!。\s])+$/;
    const statusTitle = text
      .replace(
        /(?:现在|目前|最近|请问|那个|那项|这项|的)?(?:进度(怎么样|如何)?|进展(怎么样|如何)?|怎么样|安排好了[吗么]|做到哪一步)(了|呢)?[？?。\s]*$/,
        "",
      )
      .trim();
    const named =
      statusTitle &&
      statusTitle !== text &&
      !/[，,；;。！？\n]/.test(statusTitle) &&
      goals.filter(
        (g) =>
          g.title.includes(statusTitle) ||
          (/^(?:GitHub\s*)?热榜$/i.test(statusTitle) &&
            /GitHub.*Trending|热榜/i.test(g.title)),
      );
    let actions: Intent[];
    if (directoryChoices.length > 1)
      actions = [
        {
          type: "clarify",
          target: "",
          at: "",
          cadence: "once",
          notify: "always",
          text: `这几项委托都在等目录恢复：${directoryChoices.map((h) => `「${h.title}」`).join("、")}。请回复要继续的那条目录提醒。`,
        },
      ];
    else if (named && named.length === 1)
      actions = [
        {
          type: "status",
          target: named[0].id,
          text: "",
          at: "",
          cadence: "once",
          notify: "always",
        },
      ];
    else if (
      generic.test(text) &&
      /怎么样|进度|进展|到哪一步|安排好了吗|情况|如何/.test(text)
    )
      actions = [
        {
          type: "status",
          target: /都|总体|全部/.test(text) ? "" : focus,
          text: "",
          at: "",
          cadence: "once",
          notify: "always",
        },
      ];
    else if (
      !bound.length &&
      goals.filter((g) => g.state === "active").length > 1 &&
      /^(?:把那个|先|把它|请)?(?:停一下|暂停|停了|停掉)[吧了。！!]*$/.test(text)
    )
      actions = [
        {
          type: "clarify",
          text: "要暂停哪一项委托？请告诉我名称。",
          target: "",
          at: "",
          cadence: "once",
          notify: "always",
        },
      ];
    else
      actions = await this.route(
        {
          text,
          goals: goals.map(({ id, title, state }) => ({ id, title, state })),
          projects: db
            .projects()
            .map(({ name, enabled }) => ({ name, enabled: !!enabled })),
          replyTargets: bound,
          recentFocus: focus,
          replyText: followup ? followup.question : reply?.body.slice(0, 400) ?? null,
          followup,
          recent: recent.map((m) => ({
            role: m.role,
            text: m.body,
            goals: refs(m.id),
            time: m.created,
          })),
          localTime: instant.toString(),
        },
        execMeter(db, null),
      );
    const supplements = actions.filter(a => a.type === "supply" || a.type === "supply_partial");
    if (supplements.length && (!followup || actions.length !== 1 || supplements[0].target !== followup.goal ||
        (supplements[0].type === "supply_partial" && !supplements[0].text.trim())))
      throw new Problem("无法将补充资料关联到原问题，请回复要补充的那条消息。");
    // A clarifying question supersedes proposed side effects.
    const clarify = actions.find((a) => a.type === "clarify");
    if (clarify) actions = [clarify];
    for (const a of actions) {
      if (
        [
          "pause",
          "stop",
          "resume",
          "preference",
          "rerun",
          "reschedule",
        ].includes(a.type) &&
        (!a.target ||
          !goals.some((g) => g.id === a.target) ||
          (bound.length && !bound.includes(a.target)))
      ) {
        actions = [
          {
            ...a,
            type: "clarify",
            text: "你指的是哪一项委托？请告诉我名称，或回复它的消息。",
          },
        ];
        break;
      }
    }
    const links: string[] = [],
      answers: string[] = [],
      interrupts: Row[] = [];
    db.tx(() => {
      const user = post(
        db,
        "user",
        "message",
        text,
        [],
        "in:" + b.key,
        b.replyTo || null,
        b.key,
        b.focus ?? null,
      );
      for (const a of actions) {
        if (a.type === "supply" || a.type === "supply_partial") {
          const target = followup!;
          links.push(target.goal);
          const missing = a.type === "supply_partial" ? redact(a.text.trim()) : undefined;
          if (!answerFollowup(db, target, user, text, missing))
            answers.push("原问题当前不能继续接收资料。" + progress(db, this.s.goal(target.goal)));
          else if (!missing)
            answers.push("资料已收到，已排队继续原委托。");
          continue;
        }
        if (a.type === "talk" || a.type === "clarify") {
          answers.push(a.text);
          continue;
        }
        if (a.type === "status") {
          const targets = a.target
            ? [this.s.goal(a.target)]
            : goals.filter((g) => !["completed", "archived"].includes(g.state));
          const show = targets.length ? targets : goals.slice(0, 5);
          answers.push(
            show.map((g) => progress(db, this.s.goal(g.id))).join("\n\n") ||
              "目前没有委托。",
          );
          links.push(...show.map((g) => g.id));
          continue;
        }
        if (["work", "reminder", "trending"].includes(a.type)) {
          if (!a.text.trim()) throw new Problem("委托内容不能为空。");
          if (a.type === "work" && a.notify === "changes")
            throw new Problem(
              "当前有变化再报支持 GitHub 热榜；其他委托可按时交付。",
            );
          const hint = a.type === "work" ? a.project?.trim() : "";
          let project: Row | undefined;
          if (hint) {
            const matches = db.projects().filter((p) => sameName(p.name, hint));
            if (
              matches.length === 1 &&
              matches[0].enabled &&
              text.toLowerCase().includes(hint.toLowerCase()) &&
              a.text.toLowerCase().includes(hint.toLowerCase())
            )
              project = matches[0];
            else {
              when(a, instant);
              const question =
                hint === "?" || matches.length > 1
                  ? `「${a.text}」要在哪个项目里做？`
                  : matches.length === 1 && !matches[0].enabled
                    ? `「${hint}」已停用。要重新启用它来处理「${a.text}」吗？`
                    : `要处理「${a.text}」，请确认「${hint}」对应的本地项目。`;
              const id = post(
                db,
                "assistant",
                "project",
                question,
                [],
                "project:" + uid(),
                user,
              );
              db.run(
                "INSERT INTO main_project_questions(message_id,request_id,intent,asked_at) VALUES(?,?,?,?)",
                id,
                user,
                JSON.stringify(a),
                instant.toISOString(),
              );
              continue;
            }
          }
          const created = this.accept(a, instant, project);
          links.push(created.goal);
          answers.push(created.answer);
          continue;
        }
        const g = this.s.goal(a.target);
        links.push(g.id);
        const t = db.one("SELECT * FROM main_tasks WHERE goal_id=?", g.id);
        if (
          g.state === "active" &&
          (a.type === "resume" || a.type === "rerun")
        ) {
          const atRequest = goals.find(
            (goal) => goal.id === g.id,
          )?.directoryNotice;
          const hold = atRequest
            ? db.must(
                "SELECT * FROM directory_holds WHERE notice_id=?",
                atRequest,
              )
            : pendingDirectory(db, g.id);
          if (hold) {
            if (hold.resolved_at) {
              answers.push(progress(db, g));
              continue;
            }
            try {
              answers.push(releaseDirectory(db, hold, user));
            } catch (e) {
              if (!(e instanceof Problem)) throw e;
              answers.push(progress(db, g));
            }
            continue;
          }
        }
        if (a.type === "pause" || a.type === "stop" || a.type === "resume") {
          if (["archived", "completed"].includes(g.state))
            throw new Problem("这项委托已经结束。");
          db.run(
            "UPDATE goals SET state=?,updated=? WHERE id=?",
            a.type === "stop"
              ? "archived"
              : a.type === "pause"
                ? "paused"
                : "active",
            now(),
            g.id,
          );
          if (a.type === "stop") {
            const live = db.one(
              "SELECT id,provider FROM agent_runs WHERE goal_id=? AND status IN ('running','waiting_approval')",
              g.id,
            );
            if (live) interrupts.push(live);
            db.run(
              "UPDATE schedule_jobs SET state='disabled' WHERE goal_id=?",
              g.id,
            );
            db.run("UPDATE main_tasks SET next_at=NULL WHERE goal_id=?", g.id);
          }
          answers.push(
            `${g.title}：${a.type === "pause" ? "已暂停新的执行。" : a.type === "stop" ? "已停止后续工作，不再投递结果。" : "已恢复。"} `,
          );
        } else if (a.type === "preference") {
          const prefs: string[] = JSON.parse(g.constraints_json);
          if (!prefs.includes(a.text)) {
            if (prefs.length >= 30) throw new Problem("委托要求过多。");
            prefs.push(redact(a.text));
          }
          db.run(
            "UPDATE goals SET constraints_json=?,updated=? WHERE id=?",
            JSON.stringify(prefs),
            now(),
            g.id,
          );
          answers.push(
            `已记住「${g.title}」的新要求：${a.text}。下次生效，不会重跑。`,
          );
        } else if (a.type === "reschedule") {
          if (!t || g.state !== "active")
            throw new Problem("该委托不能在此修改排期，请查看委托详情。");
          const { next, clock } = when(a, instant);
          db.run(
            "UPDATE main_tasks SET next_at=?,clock=?,cadence=? WHERE goal_id=?",
            next,
            clock,
            a.cadence,
            g.id,
          );
          answers.push(`已调整「${g.title}」：下次 ${stamp(next!)}。`);
        } else if (a.type === "rerun") {
          if (g.state !== "active" || t?.mode === "reminder")
            throw new Problem("这项委托当前不能重新执行。");
          if (
            t?.mode !== "trending" &&
            !db.must(
              "SELECT enabled FROM workspaces WHERE id=?",
              g.workspace_id,
            ).enabled
          ) {
            answers.push(
              `「${g.title}」关联的项目已停用，请在设置的「已授权项目」中重新启用后再继续。`,
            );
            continue;
          }
          if (t?.mode === "trending")
            db.run(
              "UPDATE main_tasks SET next_at=? WHERE goal_id=?",
              now(),
              g.id,
            );
          else
            db.run(
              "INSERT INTO user_messages(id,goal_id,scope,ref,content,created,status) VALUES(?,?,'goal',?,?,?,'queued')",
              uid(),
              g.id,
              g.id,
              redact(a.text || text),
              now(),
            );
          answers.push(`已安排重新执行「${g.title}」。`);
        }
      }
      for (const goal of new Set(links))
        db.run("INSERT INTO main_refs VALUES(?,?)", user, goal);
      if (answers.length)
        post(
          db,
          "assistant",
          actions.every((a) => a.type === "status")
            ? "status"
            : actions.some((a) => a.type === "clarify")
              ? "question"
              : "ack",
          answers.join("\n\n"),
          links,
          "ack:" + user,
          user,
        );
    });
    // Cancellation is best-effort and comes after the committed withdrawal.
    // A provider may already have performed an external action.
    for (const r of interrupts)
      void this.s.adapters[r.provider].interrupt(r.id).catch(() => {});
    return { id: b.key };
  }
}
