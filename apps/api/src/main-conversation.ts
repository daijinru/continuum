import { z } from "zod";
import { execMeter } from "./usage.ts";
import { now, uid, Problem, type Row, type Store } from "./db.ts";
import type { Service } from "./service.ts";
import { interpret, type Intent, type Interpret } from "./main-model.ts";
import { redact } from "../../../packages/agent-core/src/index.ts";

export const sendInput = z
  .object({
    key: z.string().uuid(),
    text: z.string().trim().min(1).max(4000),
    replyTo: z.string().uuid().optional(),
    focus: z.string().uuid().optional(),
    workspaceId: z.string().uuid().optional(),
  })
  .strict();
type Send = z.infer<typeof sendInput>;
export const stamp = (date: string) =>
  new Date(date).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
export function post(
  db: Store,
  role: "assistant" | "user",
  kind: string,
  body: string,
  ids: string[],
  origin: string,
  reply: string | null = null,
  id: string = uid(),
) {
  const created = db.run(
    "INSERT INTO main_messages(id,role,kind,body,reply_to,origin,created) VALUES(?,?,?,?,?,?,?) ON CONFLICT(origin) DO NOTHING",
    id,
    role,
    kind,
    body,
    reply,
    origin,
    now(),
  );
  if (!created.changes)
    return db.must("SELECT id FROM main_messages WHERE origin=?", origin)
      .id as string;
  for (const goal of new Set(ids))
    db.run("INSERT INTO main_refs VALUES(?,?)", id, goal);
  return id;
}
export function timeline(db: Store, before = Number.MAX_SAFE_INTEGER): Row[] {
  return db
    .all(
      `SELECT m.*,coalesce((SELECT json_group_array(json_object('id',g.id,'title',g.title)) FROM goals g JOIN main_refs r ON r.goal_id=g.id WHERE r.message_id=m.id),'[]') refs
    FROM main_messages m WHERE seq<? ORDER BY seq DESC LIMIT 80`,
      before,
    )
    .reverse()
    .map((m) => ({ ...m, refs: JSON.parse(m.refs) }));
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
      "SELECT title FROM raw_events WHERE run_id=? AND type='agent.message' ORDER BY seq DESC LIMIT 1",
      r.id,
    );
    post(
      db,
      "assistant",
      type === "succeeded" ? "result" : "problem",
      type === "succeeded"
        ? last?.title || "本轮已结束，没有可阅读的回复。"
        : `本轮${type === "interrupted" ? "已中断" : "未完成"}：${title}`,
      [g.id],
      "run:" + r.id,
    );
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
  const facts = [labels[g.state], t?.last_note];
  if (t?.mode === "trending") {
    if (t.attempted) facts.push("上次尝试 " + stamp(t.attempted));
    facts.push(
      t.succeeded ? "最近成功读取 " + stamp(t.succeeded) : "尚无成功读取记录",
    );
  } else if (r) {
    facts.push(labels[r.status] || r.status);
    const e = db.one(
      "SELECT title FROM raw_events WHERE run_id=? AND type IN ('agent.message','run.failed','system.disconnected','approval.requested','input.requested') ORDER BY seq DESC LIMIT 1",
      r.id,
    );
    if (e) facts.push(String(e.title).replace(/\s+/g, " ").slice(0, 140));
  } else if (!t?.last_note)
    facts.push(t?.mode === "reminder" ? "提醒已登记" : "尚无执行记录");
  if (g.state === "active" && next) facts.push("下次 " + stamp(next));
  return `${g.title}：${facts.filter(Boolean).join("；")}。`;
}

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
  async handle(b: Send) {
    const { db } = this.s,
      text = redact(b.text);
    const previous = db.one("SELECT * FROM main_messages WHERE id=?", b.key);
    if (previous) {
      if (
        previous.role !== "user" ||
        previous.body !== text ||
        previous.reply_to !== (b.replyTo || null)
      )
        throw new Problem("消息编号冲突", 409);
      return { id: b.key };
    }
    if (b.replyTo)
      db.must("SELECT id FROM main_messages WHERE id=?", b.replyTo);
    if (b.focus) this.s.goal(b.focus);
    const goals = db.all(
      "SELECT id,title,state,updated FROM goals ORDER BY updated DESC",
    );
    const recent = db
      .all(
        "SELECT id,role,kind,substr(body,1,400) body,created FROM main_messages WHERE kind IN('message','ack','question','status','answer') ORDER BY seq DESC LIMIT 8",
      )
      .reverse();
    const last = recent.at(-1);
    const refs = (id: string) =>
      db
        .all("SELECT goal_id FROM main_refs WHERE message_id=?", id)
        .map((r) => r.goal_id as string);
    const bound = b.replyTo ? refs(b.replyTo) : b.focus ? [b.focus] : [];
    const fresh = last && Date.now() - Date.parse(last.created) < 10 * 60_000;
    const focus =
      bound.length === 1
        ? bound[0]
        : !b.replyTo &&
            fresh &&
            last.kind === "ack" &&
            refs(last.id).length === 1
          ? refs(last.id)[0]
          : "";
    const instant = new Date();
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
    if (named && named.length === 1)
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
      actions = await this.route({
        text,
        goals: goals.map(({ id, title, state }) => ({ id, title, state })),
        replyTargets: bound,
        recentFocus: focus,
        replyText: b.replyTo
          ? db.must(
              "SELECT substr(body,1,400) body FROM main_messages WHERE id=?",
              b.replyTo,
            ).body
          : null,
        recent: recent.map((m) => ({
          role: m.role,
          text: m.body,
          goals: refs(m.id),
          time: m.created,
        })),
        localTime: instant.toString(),
      }, execMeter(db, null));
    // A clarifying question supersedes proposed side effects. All parts of a
    // compound instruction commit together or none do.
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
      );
      for (const a of actions) {
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
          const { next, clock } = when(a, instant),
            immediate = a.type === "work" && !a.at;
          const g = this.s.createCommission(
            a.text,
            uid(),
            a.type === "work" ? b.workspaceId : undefined,
            immediate,
          );
          db.run(
            "INSERT INTO main_tasks(goal_id,mode,cadence,clock,next_at,notify) VALUES(?,?,?,?,?,?)",
            g.id,
            a.type,
            a.cadence,
            clock,
            a.type === "trending" && !a.at ? instant.toISOString() : next,
            a.notify,
          );
          links.push(g.id);
          answers.push(
            `已接下「${g.title}」。${a.type === "trending" ? (a.notify === "changes" ? "只在有符合要求的新项目时告诉你。" : "按约定给你一份热榜结果。") : immediate ? "已排队执行。" : ""}${next ? `下次${a.type === "reminder" ? "提醒" : "执行"}：${stamp(next)}${a.cadence === "weekdays" ? "（工作日）" : a.cadence === "daily" ? "（每天）" : ""}。` : ""}`,
          );
          continue;
        }
        const g = this.s.goal(a.target);
        links.push(g.id);
        const t = db.one("SELECT * FROM main_tasks WHERE goal_id=?", g.id);
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
