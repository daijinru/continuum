import { load } from "cheerio";
import type { Service } from "./service.ts";
import { uid, now, type Row } from "./db.ts";
import { chooseRepos, type Repo } from "./main-model.ts";
import { nextSlot, post, stamp } from "./main-conversation.ts";

const source = "https://github.com/trending";
export function trendingRepos(html: string): Repo[] {
  const $ = load(html),
    seen = new Set<string>(),
    repos: Repo[] = [];
  $("article.Box-row").each((_, row) => {
    const path = $(row).find("h2 a").attr("href") || "";
    if (!/^\/[\w.-]+\/[\w.-]+$/.test(path) || seen.has(path.toLowerCase()))
      return;
    seen.add(path.toLowerCase());
    repos.push({
      id: path.slice(1),
      description: $(row).find("p").first().text().trim().slice(0, 400),
    });
  });
  if (!repos.length) throw Error("未能识别当次 GitHub 榜单");
  return repos;
}
async function fetchTrending() {
  const r = await fetch(source, {
    redirect: "error",
    signal: AbortSignal.timeout(15000),
    headers: { Accept: "text/html" },
  });
  if (!r.ok) throw Error(`GitHub 返回 ${r.status}`);
  const reader = r.body?.getReader();
  if (!reader) throw Error("榜单为空");
  const chunks: Uint8Array[] = [];
  let n = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > 3_000_000) {
      await reader.cancel();
      throw Error("榜单过大");
    }
    chunks.push(value);
  }
  return trendingRepos(Buffer.concat(chunks).toString("utf8"));
}

// Native reminders and source checks are independent of the Codex run queue:
// a slow fetch or ranking call must not hold a due reminder or a progress query.
export class MainAgenda {
  s: Service;
  fetchRepos: () => Promise<Repo[]>;
  choose: typeof chooseRepos;
  active = new Map<string, Promise<void>>();
  timer?: ReturnType<typeof setInterval>;
  constructor(s: Service, fetchRepos = fetchTrending, choose = chooseRepos) {
    this.s = s;
    this.fetchRepos = fetchRepos;
    this.choose = choose;
  }
  start() {
    this.timer = setInterval(() => this.tick(), 1000);
  }
  async stop() {
    clearInterval(this.timer);
    await Promise.allSettled(this.active.values());
  }
  tick(at = new Date()) {
    const { db } = this.s;
    const due = db.all(
      `SELECT t.*,g.title,g.description,g.constraints_json,g.updated FROM main_tasks t JOIN goals g ON g.id=t.goal_id
      WHERE g.state='active' AND t.next_at<=? ORDER BY t.next_at`,
      at.toISOString(),
    );
    for (const t of due) {
      if (t.mode === "trending") {
        if (this.active.has(t.goal_id) || this.active.size >= 2) continue;
        const task = this.watch(t, at).finally(() =>
          this.active.delete(t.goal_id),
        );
        this.active.set(t.goal_id, task);
        void task.catch((err) =>
          console.error(
            "热榜处理失败",
            err instanceof Error ? err.name : "error",
          ),
        );
      } else
        db.tx(() => {
          if (t.mode === "reminder") {
            const late = +at - Date.parse(t.next_at) > 60_000;
            post(
              db,
              "assistant",
              "reminder",
              `${late ? "补发提醒（原定 " + stamp(t.next_at) + "）" : "到时间了"}：${t.description}`,
              [t.goal_id],
              `remind:${t.goal_id}:${t.next_at}`,
            );
            if (t.cadence === "once")
              db.run(
                "UPDATE goals SET state='completed',updated=? WHERE id=?",
                now(),
                t.goal_id,
              );
          } else {
            const limits = {
              ...this.s.config(),
              ...JSON.parse(
                db.one(
                  "SELECT config FROM goal_limits WHERE goal_id=?",
                  t.goal_id,
                )?.config || "{}",
              ),
            };
            const day = new Date(at);
            day.setHours(0, 0, 0, 0);
            const count = db.must(
              "SELECT count(*) n FROM agent_runs WHERE goal_id=? AND created>=?",
              t.goal_id,
              day.toISOString(),
            ).n;
            const last = db.one(
              "SELECT finished FROM agent_runs WHERE goal_id=? ORDER BY created DESC LIMIT 1",
              t.goal_id,
            );
            if (
              count >= limits.budget ||
              (last &&
                (!last.finished ||
                  +at - Date.parse(last.finished) <
                    limits.cooldown * 60_000)) ||
              db.one(
                "SELECT 1 FROM user_messages WHERE goal_id=? AND status IN('queued','dispatching')",
                t.goal_id,
              )
            ) {
              db.run(
                "UPDATE main_tasks SET next_at=?,last_note=? WHERE goal_id=?",
                new Date(+at + 60_000).toISOString(),
                "等待当前工作、冷却期或运行额度",
                t.goal_id,
              );
              return;
            }
            db.run(
              "INSERT INTO user_messages(id,goal_id,scope,ref,content,created,status) VALUES(?,?,'goal',?,?,?,'queued')",
              uid(),
              t.goal_id,
              t.goal_id,
              t.description,
              now(),
            );
          }
          db.run(
            "UPDATE main_tasks SET next_at=?,attempted=?,last_note=? WHERE goal_id=?",
            this.next(t, at),
            at.toISOString(),
            t.mode === "reminder" ? "已在主对话提醒" : "本次工作已排队",
            t.goal_id,
          );
        });
    }
  }
  private next(t: Row, at: Date) {
    return t.cadence === "once" ? null : nextSlot(t.cadence, t.clock, at);
  }
  private current(t: Row) {
    return this.s.db.one(
      `SELECT 1 FROM goals g JOIN main_tasks t ON t.goal_id=g.id WHERE g.id=? AND g.state='active' AND t.next_at=? AND g.updated=? AND g.constraints_json=?`,
      t.goal_id,
      t.next_at,
      t.updated,
      t.constraints_json,
    );
  }
  private async watch(t: Row, at: Date) {
    const { db } = this.s,
      checked = at.toISOString();
    db.run(
      "UPDATE main_tasks SET attempted=? WHERE goal_id=?",
      checked,
      t.goal_id,
    );
    let phase = "读取榜单";
    try {
      const items = await this.fetchRepos();
      phase = "筛选项目";
      const prior = db.all(
        "SELECT item FROM main_notified WHERE goal_id=?",
        t.goal_id,
      );
      const known = new Set(prior.map((r) => r.item));
      const previous = db.one(
        "SELECT snapshot,preferences FROM main_observations WHERE goal_id=? ORDER BY checked DESC LIMIT 1",
        t.goal_id,
      );
      const seen = new Map<string, string>(
        previous && previous.preferences === t.constraints_json
          ? JSON.parse(previous.snapshot).map((i: Repo) => [
              i.id.toLowerCase(),
              i.description,
            ])
          : [],
      );
      const candidates =
        t.notify === "changes"
          ? items.filter(
              (i) =>
                !known.has(i.id.toLowerCase()) &&
                seen.get(i.id.toLowerCase()) !== i.description,
            )
          : items;
      const picks = candidates.length
        ? await this.choose(
            t.description + "\n" + JSON.parse(t.constraints_json).join("\n"),
            candidates,
          )
        : [];
      if (!this.current(t)) return;
      db.tx(() => {
        db.run(
          "INSERT INTO main_observations VALUES(?,?,?,?,?,?)",
          t.goal_id,
          t.next_at,
          checked,
          source,
          JSON.stringify(items),
          t.constraints_json,
        );
        const note = picks.length
          ? `本次推荐 ${picks.length} 项。`
          : "本次成功检查，没有符合要求的新推荐。";
        if (picks.length || t.notify === "always") {
          const body = `${note}\n\n${picks.map((p) => `- [${p.id}](https://github.com/${p.id})：${p.reason}`).join("\n")}\n\n[来源：GitHub Trending](${source}) · ${stamp(checked)}`;
          const msg = post(
            db,
            "assistant",
            "result",
            body,
            [t.goal_id],
            `watch:${t.goal_id}:${t.next_at}`,
          );
          for (const p of picks)
            db.run(
              "INSERT OR IGNORE INTO main_notified VALUES(?,?,?)",
              t.goal_id,
              p.id.toLowerCase(),
              msg,
            );
        }
        db.run(
          "UPDATE main_tasks SET next_at=?,succeeded=?,last_note=?,failures=0 WHERE goal_id=?",
          this.next(t, at),
          checked,
          note,
          t.goal_id,
        );
      });
    } catch {
      if (!this.current(t)) return;
      db.tx(() => {
        const count = t.failures + 1,
          note = `这次未能${phase}，不能判断有没有新项目。`;
        if (count === 3)
          post(
            db,
            "assistant",
            "problem",
            `${t.title}：连续三次检查未完成。${t.succeeded ? "最近成功检查：" + stamp(t.succeeded) + "。" : "尚无成功检查。"}`,
            [t.goal_id],
            `watch-failed:${t.goal_id}:${t.next_at}`,
          );
        const next =
          count < 3
            ? new Date(+at + 60_000 * count).toISOString()
            : this.next(t, at);
        db.run(
          "UPDATE main_tasks SET next_at=?,last_note=?,failures=? WHERE goal_id=?",
          next,
          note,
          count,
          t.goal_id,
        );
      });
    }
  }
}
