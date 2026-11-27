import { now, type Row, type Store } from "./db.ts";
import { post } from "./main-messages.ts";

export function followupFor(db: Store, message: Row) {
  const saved = db.one(
    "SELECT * FROM followup_questions WHERE message_id=?",
    message.id,
  );
  // Live questions are tied to the exact provider event. Older unmarked
  // questions can still be answered by replying to the terminal result.
  const live =
    message.origin?.startsWith("event:") && message.kind === "question"
      ? db.one(
          "SELECT run_id,json_extract(payload,'$.followup') question FROM raw_events WHERE id=?",
          message.id,
        )
      : undefined;
  if (
    !saved &&
    !live &&
    (!["result", "history"].includes(message.kind) ||
      !message.origin?.startsWith("run:"))
  )
    return;
  const run = db.one(
    "SELECT id,goal_id,status FROM agent_runs WHERE id=?",
    saved?.run_id ?? live?.run_id ?? message.origin.slice(4),
  );
  if (
    !run ||
    (run.status !== "succeeded" &&
      !(
        (live || saved) &&
        ["starting", "running", "waiting_approval"].includes(run.status)
      ))
  )
    return;

  const pending =
    saved?.answer_id &&
    db.one(
      "SELECT message_id,question FROM followup_questions WHERE run_id=? AND answer_id IS NULL",
      run.id,
    );
  return {
    run: String(run.id),
    goal: String(run.goal_id),
    message: String(pending?.message_id ?? message.id),
    question: String(
      pending?.question ?? saved?.question ?? live?.question ?? message.body,
    ),
    original: live
      ? message.body
      : (db.one(
          "SELECT body FROM main_messages WHERE origin=?",
          "run:" + run.id,
        )?.body ?? message.body),
    answers: answersFor(db, run.id),
  };
}

function answersFor(db: Store, run: string) {
  return db
    .all(
      `SELECT f.question, m.body answer FROM followup_questions f
    JOIN main_messages m ON m.id=f.answer_id WHERE f.run_id=? ORDER BY m.seq`,
      run,
    )
    .map((row) => ({
      question: String(row.question),
      answer: String(row.answer),
    }));
}

// Use the user's actual answers in the resumed execution, including partial
// replies that never reached the provider. The queue key is the final reply ID.
export function followupInstruction(db: Store, goalId: string, key: string) {
  const source = db.one(
    `SELECT f.run_id FROM followup_questions f JOIN user_messages u ON u.id=f.answer_id
      WHERE u.id=? AND u.goal_id=? AND u.source_run=f.run_id`,
    key,
    goalId,
  );
  if (!source) return "";
  return (
    "\n继续原委托，以下是这次追问收到的资料：\n" +
    answersFor(db, source.run_id)
      .map((entry) => entry.question + "\n用户回复：" + entry.answer)
      .join("\n")
  );
}

export function waitingFor(db: Store, run: string) {
  return db.one(
    `SELECT question,
    (SELECT m.body FROM followup_questions p JOIN main_messages m ON m.id=p.answer_id
     WHERE p.run_id=f.run_id ORDER BY m.seq DESC LIMIT 1) last_answer
    FROM followup_questions f WHERE f.run_id=? AND f.answer_id IS NULL`,
    run,
  );
}

export type Followup = NonNullable<ReturnType<typeof followupFor>>;

// Called inside the transaction that records the reply, after interpretation.
export function answerFollowup(
  db: Store,
  target: Followup,
  user: string,
  text: string,
  missing?: string,
) {
  const latest = db.one(
    "SELECT id,status FROM agent_runs WHERE goal_id=? ORDER BY created DESC,rowid DESC LIMIT 1",
    target.goal,
  );
  const open = db.one(
    "SELECT answer_id FROM followup_questions WHERE message_id=?",
    target.message,
  );
  const canContinue = db.one(
    "SELECT id FROM dispatchable_goals WHERE id=?",
    target.goal,
  );
  const queued = db.one(
    "SELECT id FROM user_messages WHERE goal_id=? AND status IN ('queued','dispatching')",
    target.goal,
  );
  const waiting = db.one(
    "SELECT message_id FROM followup_questions WHERE run_id=? AND answer_id IS NULL",
    target.run,
  );
  if (
    (waiting && waiting.message_id !== target.message) ||
    !canContinue ||
    queued ||
    latest?.id !== target.run ||
    !["running", "starting", "waiting_approval", "succeeded"].includes(
      latest.status,
    ) ||
    open?.answer_id
  )
    return false;
  db.run(
    `INSERT INTO followup_questions(message_id,run_id,question,answer_id) VALUES(?,?,?,?)
    ON CONFLICT(message_id) DO UPDATE SET answer_id=excluded.answer_id`,
    target.message,
    target.run,
    target.question,
    user,
  );
  if (missing) {
    const id = post(
      db,
      "assistant",
      "question",
      missing,
      [target.goal],
      "followup:" + user,
      user,
    );
    db.run(
      "INSERT INTO followup_questions(message_id,run_id,question) VALUES(?,?,?)",
      id,
      target.run,
      missing,
    );
  } else {
    db.run(
      `INSERT INTO user_messages(id,goal_id,scope,ref,content,created,status,source_run)
      VALUES(?,?,'goal',?,?,?,'queued',?)`,
      user,
      target.goal,
      target.goal,
      text,
      now(),
      target.run,
    );
  }
  return true;
}
