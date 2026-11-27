import {
  Store,
  now,
  uid,
  verifiedFile,
  type Row,
} from "../../../apps/api/src/db.ts";
import { type Observation, redact } from "../../agent-core/src/index.ts";
export function score(
  impact: number,
  action: number,
  novelty: number,
  risk: number,
  priority: number,
) {
  return (
    Math.round(
      100 *
        (0.3 * impact +
          0.25 * action +
          0.2 * novelty +
          0.15 * risk +
          (0.1 * priority) / 5),
    ) / 100
  );
}
export function projectStory(db: Store, run: Row, event: Row, e: Observation) {
  const goal = db.must("SELECT * FROM goals WHERE id=?", run.goal_id);
  const file = e.path
    ? verifiedFile(
        db.must("SELECT path FROM workspaces WHERE id=?", goal.workspace_id)
          .path,
        e.path,
      )
    : null;
  const tested =
    e.type === "test.completed" && typeof e.data?.passed === "boolean";
  const failed =
    (tested && e.data?.passed === false) ||
    (e.type === "system.reconciled" && e.data?.status === "failed") ||
    e.type === "run.failed" ||
    e.type === "system.disconnected";
  if (
    !e.unit &&
    !failed &&
    ![
      "system.reconciled",
      "agent.message",
      "file.changed",
      "plan.updated",
      "artifact.created",
    ].includes(e.type)
  )
    return;
  const unit =
    run.provider +
    ":" +
    redact(
      e.unit ||
        (["system.disconnected", "system.reconciled"].includes(e.type)
          ? "connection:" + run.id
          : event.id),
    );
  const old = db.one(
    "SELECT * FROM stories WHERE goal_id=? AND unit=?",
    goal.id,
    unit,
  );
  const id = old?.id || uid();
  const later =
    old &&
    db.must("SELECT occurred FROM raw_events WHERE seq=?", old.last_seq)
      .occurred > event.occurred;
  const passive = old?.verification === "disputed" && e.type === "plan.updated";
  const verification = failed
    ? "disputed"
    : file || tested
      ? "verified"
      : e.type === "agent.message" || e.type === "system.reconciled"
        ? "reported"
        : "unverified";
  const category = failed
    ? "risk"
    : e.approval
      ? "decision"
      : file || tested
        ? "outcome"
        : e.type === "agent.message"
          ? "insight"
          : "change";
  const title = redact(e.title);
  const rank = score(
    file || tested || failed ? 1 : 0.55,
    e.approval ? 1 : 0,
    1,
    failed ? 1 : 0,
    goal.priority,
  );
  const repeatedFailure =
    failed && old?.verification === "disputed" && old?.summary === title;
  if (!later && !passive && !repeatedFailure) {
    db.run(
      "INSERT INTO stories VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(goal_id,unit) DO UPDATE SET title=excluded.title,summary=excluded.summary,category=excluded.category,verification=excluded.verification,materiality=excluded.materiality,version=excluded.version,last_seq=excluded.last_seq,updated=excluded.updated",
      id,
      goal.id,
      unit,
      title.slice(0, 120),
      title,
      category,
      verification,
      rank,
      (old?.version || 0) + 1,
      event.seq,
      event.received,
    );
    db.run(
      "INSERT INTO story_versions VALUES(?,?,?,?,?)",
      id,
      (old?.version || 0) + 1,
      title,
      verification,
      event.id,
    );
  }
  db.run("INSERT INTO story_events VALUES(?,?)", id, event.id);
  if (file)
    db.run(
      "INSERT INTO artifacts VALUES(?,?,?,?,?,?,?) ON CONFLICT(run_id,path) DO UPDATE SET verified=excluded.verified",
      uid(),
      run.id,
      goal.id,
      id,
      file,
      now(),
      "file",
    );
}
// A provider's last reply is a delivery only once that particular run has
// succeeded. Window by completion event, not by when the reply was written.
export function reports(
  db: Store,
  after: number,
  until: number,
  goalId: string | null = null,
) {
  return db.all(
    `SELECT m.id,g.id goal_id,g.title goal,r.id run_id,r.provider,
      g.title title,m.title summary,w.name workspace,'insight' category,'reported' verification,
      e.received updated,e.seq last_seq
    FROM raw_events e JOIN agent_runs r ON r.id=e.run_id JOIN goals g ON g.id=r.goal_id JOIN workspaces w ON w.id=g.workspace_id
    JOIN raw_events m ON m.seq=(SELECT max(x.seq) FROM raw_events x
      WHERE x.run_id=r.id AND x.type='agent.message' AND x.seq<=e.seq)
    WHERE NOT EXISTS (SELECT 1 FROM followup_questions f WHERE f.run_id=r.id)
      AND r.status='succeeded' AND (e.type='run.completed' OR
      (e.type='system.reconciled' AND json_extract(e.payload,'$.status')='succeeded'))
      AND e.seq=(SELECT min(y.seq) FROM raw_events y WHERE y.run_id=r.id AND
        (y.type='run.completed' OR (y.type='system.reconciled' AND json_extract(y.payload,'$.status')='succeeded')))
      AND e.seq>? AND e.seq<=? AND (? IS NULL OR g.id=?)
    ORDER BY e.seq DESC`,
    after,
    until,
    goalId,
    goalId,
  );
}
export function generate(
  db: Store,
  window: "since" | "today" | "week" = "since",
) {
  return db.tx(() => {
    const cursor = db.must("SELECT * FROM attention_cursors");
    const end = db.must(
      "SELECT coalesce(max(seq),0) AS seq FROM raw_events",
    ).seq;
    const startDate = new Date();
    startDate.setHours(0, 0, 0, 0);
    if (window === "week") startDate.setDate(startDate.getDate() - 6);
    const start =
      window === "since"
        ? cursor.seq
        : db.must(
            "SELECT coalesce(max(seq),0) AS seq FROM raw_events WHERE received<?",
            startDate.toISOString(),
          ).seq;
    const begin =
      window === "since" ? cursor.reviewed : startDate.toISOString();
    const needs = db.all(
      "SELECT i.*,g.title goal,r.provider FROM inbox_items i JOIN goals g ON g.id=i.goal_id JOIN agent_runs r ON r.id=i.run_id WHERE i.status IN('pending','deferred') ORDER BY i.created",
    );
    const jobs = db.all(
      "SELECT j.id,j.goal_id,j.instruction,j.next_at,g.title goal FROM schedule_jobs j JOIN goals g ON g.id=j.goal_id WHERE j.state='enabled' AND g.state='active' ORDER BY j.next_at",
    );
    const native = db.all(
      `SELECT m.seq,m.id,g.id goal_id,g.title goal,m.body summary,m.created updated,m.kind
      FROM main_messages m JOIN main_refs r ON r.message_id=m.id JOIN goals g ON g.id=r.goal_id
      WHERE (m.origin LIKE 'watch:%' OR m.origin LIKE 'remind:%' OR m.origin LIKE 'watch-failed:%')
      AND m.seq>? AND m.created>=? ORDER BY m.seq DESC`,
      window === "since" ? cursor.main_seq : 0,
      window === "since" ? "" : begin,
    );
    const revision = JSON.stringify([
      "delivery-v2",
      native[0]?.seq || 0,
      window,
      window === "since" ? null : begin,
      start,
      end,
      needs.map((i) => [i.id, i.version]),
      jobs,
    ]);
    const old = db.one("SELECT * FROM briefings WHERE revision=?", revision);
    if (old) return unpack(old);
    const stories = db.all(
      "SELECT s.*,g.title goal,r.provider,e.run_id,e.id evidence FROM stories s JOIN goals g ON g.id=s.goal_id JOIN raw_events e ON e.seq=s.last_seq JOIN agent_runs r ON r.id=e.run_id WHERE s.last_seq>? AND s.last_seq<=? AND s.category!='decision' ORDER BY s.materiality DESC,s.last_seq DESC",
      start,
      end,
    );
    const sections = {
      needs,
      changes: stories.filter((s) => ["change", "risk"].includes(s.category)),
      outcomes: stories.filter((s) => s.category === "outcome"),
      insights: stories.filter((s) => s.category === "insight"),
      next: jobs,
    };
    const count = db.must(
      "SELECT count(*) n FROM raw_events WHERE seq>? AND seq<=?",
      start,
      end,
    ).n;
    const delivered = reports(db, start, end);
    const snapshot = {
      native,
      reports: delivered,
      window,
      sections,
      count,
      quiet:
        !needs.length &&
        !stories.length &&
        !jobs.length &&
        !delivered.length &&
        !native.length,
      goalCount: new Set([...needs, ...stories, ...jobs].map((s) => s.goal_id))
        .size,
    };
    const id = uid(),
      stamp = now();
    db.run(
      "INSERT INTO briefings VALUES(?,?,?,?,?,?,?,?)",
      id,
      revision,
      start,
      end,
      begin,
      stamp,
      stamp,
      JSON.stringify(snapshot),
    );
    for (const [section, rows] of Object.entries(sections))
      if (!["needs", "next"].includes(section))
        rows.forEach((s, i) =>
          db.run(
            "INSERT INTO briefing_stories VALUES(?,?,?,?,?,?)",
            id,
            s.id,
            s.version,
            section,
            i,
            s.summary,
          ),
        );
    return unpack(db.must("SELECT * FROM briefings WHERE id=?", id));
  });
}
export const unpack = (b: Row) => ({
  id: b.id,
  generated: b.generated,
  window_start: b.window_start,
  window_end: b.window_end,
  end_seq: b.end_seq,
  ...JSON.parse(b.snapshot),
});
export function acknowledge(db: Store, id: string) {
  const b = db.must("SELECT * FROM briefings WHERE id=?", id);
  db.run(
    "UPDATE attention_cursors SET seq=?,briefing_id=?,reviewed=?,main_seq=max(main_seq,?) WHERE id=1 AND seq<=?",
    b.end_seq,
    id,
    b.window_end,
    JSON.parse(b.snapshot).native?.[0]?.seq || 0,
    b.end_seq,
  );
  return db.must("SELECT * FROM attention_cursors");
}
