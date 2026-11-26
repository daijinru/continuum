import { DirectoryUnavailable, now, uid, type Row } from "../../api/src/db.ts";
import type { Service } from "../../api/src/service.ts";
import { checkRestoredDirectories } from "../../api/src/directory-recovery.ts";
import { generate } from "../../../packages/briefing/src/index.ts";
export class Worker {
  service: Service;
  timer?: ReturnType<typeof setInterval>;
  busy = false;
  active?: Promise<void>;
  lastTick: string | null = null;
  error: string | null = null;
  nextReconcile = 0;
  constructor(service: Service) {
    this.service = service;
  }
  start() {
    this.timer = setInterval(() => {
      if (!this.busy)
        this.active = this.tick().catch(() => {
          this.error = "调度检查失败";
        });
    }, 1000);
  }
  async stop() {
    clearInterval(this.timer);
    await this.active;
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    const s = this.service,
      db = s.db;
    try {
      const stamp = now(),
        cfg = s.config(),
        today = new Date(),
        day = today.toLocaleDateString("sv-SE"),
        time = today.toTimeString().slice(0, 5);
      if (time >= cfg.dailyTime && day !== cfg.lastDaily) {
        generate(db);
        db.run(
          "UPDATE settings SET config=?",
          JSON.stringify({ ...cfg, lastDaily: day }),
        );
      }
      if (Date.now() >= this.nextReconcile) {
        this.nextReconcile = Date.now() + 60000;
        for (const run of db.all(
          "SELECT id FROM agent_runs WHERE status='unknown' AND provider='codex' AND turn_id IS NOT NULL LIMIT 10",
        )) {
          await s.reconcile(run.id).catch(() => {});
        }
      }
      for (const item of db.all(
        "SELECT * FROM inbox_items WHERE expires<=? AND status IN('pending','deferred')",
        stamp,
      )) {
        if (!s.deciding.has(item.id)) {
          s.expire(item);
          const r = s.run(item.run_id);
          await s.adapters[r.provider].interrupt(r.id).catch(() => {});
        }
      }
      for (const r of db.all(
        "SELECT * FROM agent_runs WHERE status IN('running','waiting_approval') AND provider!='demo'",
      )) {
        const limits = this.limits(r.goal_id);
        if (Date.now() - Date.parse(r.created) > limits.maxMinutes * 60000)
          await s.adapters[r.provider].interrupt(r.id).catch(() => {});
      }
      checkRestoredDirectories(db);
      await s.applyApprovalGrants();
      for (const msg of db.all(
        "SELECT m.* FROM user_messages m JOIN dispatchable_goals g ON g.id=m.goal_id WHERE m.status IN('queued','dispatching') ORDER BY m.created LIMIT 20",
      )) {
        const previous = db.one(
          "SELECT * FROM agent_runs WHERE goal_id=? AND key=?",
          msg.goal_id,
          msg.id,
        );
        if (previous) {
          db.run(
            "UPDATE user_messages SET status='sent',run_id=? WHERE id=?",
            previous.id,
            msg.id,
          );
          continue;
        }
        if (
          db.one(
            "SELECT 1 FROM agent_runs WHERE goal_id=? AND finished IS NULL",
            msg.goal_id,
          )
        )
          continue;
        // An earlier dispatch in this batch may have yielded while the user disabled the project.
        const claimed = db.run(
          `UPDATE user_messages SET status='dispatching' WHERE id=? AND status IN('queued','dispatching')
           AND goal_id IN (SELECT id FROM dispatchable_goals)`,
          msg.id,
        );
        if (!claimed.changes) continue;
        try {
          const run = await s.start(
            msg.goal_id,
            msg.id,
            msg.content,
            false,
            "queue",
          );
          db.run(
            "UPDATE user_messages SET status='sent',run_id=? WHERE id=?",
            run.id,
            msg.id,
          );
        } catch (e) {
          db.run(
            "UPDATE user_messages SET status=? WHERE id=?",
            e instanceof DirectoryUnavailable ? "queued" : "failed",
            msg.id,
          );
        }
      }
      const jobs = db.all(
        "SELECT j.* FROM schedule_jobs j JOIN dispatchable_goals g ON g.id=j.goal_id WHERE j.state='enabled' AND j.next_at<=? AND (j.lease_until IS NULL OR j.lease_until<=?) ORDER BY j.next_at LIMIT 10",
        stamp,
        stamp,
      );
      for (const job of jobs) await this.process(job);
      this.lastTick = now();
      this.error = null;
    } finally {
      this.busy = false;
    }
  }
  limits(id: string) {
    const db = this.service.db;
    return {
      ...this.service.config(),
      ...JSON.parse(
        db.one("SELECT config FROM goal_limits WHERE goal_id=?", id)?.config ||
          "{}",
      ),
    };
  }
  async process(job: Row) {
    const s = this.service,
      db = s.db,
      stamp = now(),
      owner = uid();
    const claimed = db.run(
      `UPDATE schedule_jobs SET lease=?,lease_until=? WHERE id=? AND state='enabled' AND next_at=?
       AND (lease_until IS NULL OR lease_until<=?) AND goal_id IN (SELECT id FROM dispatchable_goals)`,
      owner,
      new Date(Date.now() + 120000).toISOString(),
      job.id,
      job.next_at,
      stamp,
    );
    if (!claimed.changes) return;
    const key = "job:" + job.id + ":" + job.next_at;
    try {
      if (
        !db.one(
          "SELECT 1 FROM agent_runs WHERE goal_id=? AND key=?",
          job.goal_id,
          key,
        )
      ) {
        const limits = this.limits(job.goal_id);
        const day = new Date();
        day.setHours(0, 0, 0, 0);
        const count = db.must(
          "SELECT count(*) n FROM agent_runs WHERE goal_id=? AND created>=?",
          job.goal_id,
          day.toISOString(),
        ).n;
        const recent = db.one(
          "SELECT finished FROM agent_runs WHERE goal_id=? ORDER BY created DESC LIMIT 1",
          job.goal_id,
        );
        if (
          count >= limits.budget ||
          (recent &&
            (!recent.finished ||
              Date.now() - Date.parse(recent.finished) <
                limits.cooldown * 60000))
        ) {
          db.run(
            "UPDATE schedule_jobs SET lease=NULL,lease_until=?,last_error=? WHERE id=? AND lease=?",
            new Date(Date.now() + 60000).toISOString(),
            "等待运行额度或冷却时间",
            job.id,
            owner,
          );
          return;
        }
        await s.start(job.goal_id, key, job.instruction, false, "schedule");
      }
      db.run(
        "UPDATE schedule_jobs SET state=?,next_at=?,lease=NULL,lease_until=NULL,attempts=0,last_error=NULL,last_run=? WHERE id=? AND lease=? AND state='enabled'",
        job.kind === "interval" ? "enabled" : "disabled",
        new Date(Date.now() + job.minutes * 60000).toISOString(),
        stamp,
        job.id,
        owner,
      );
    } catch (e) {
      if (e instanceof DirectoryUnavailable) {
        db.run(
          "UPDATE schedule_jobs SET lease=NULL,lease_until=NULL WHERE id=? AND lease=?",
          job.id,
          owner,
        );
        return;
      }
      const issued = !!db.one(
        "SELECT 1 FROM agent_runs WHERE goal_id=? AND key=?",
        job.goal_id,
        key,
      );
      const attempts = job.attempts + 1;
      db.run(
        "UPDATE schedule_jobs SET state=?,attempts=?,last_error=?,lease=NULL,lease_until=? WHERE id=? AND lease=?",
        issued || attempts >= 3 ? "paused" : "enabled",
        attempts,
        (e as Error).message,
        new Date(Date.now() + 2 ** attempts * 1000).toISOString(),
        job.id,
        owner,
      );
    }
  }
}
