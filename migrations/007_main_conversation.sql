-- The local user has exactly one conversation. A message can refer to several
-- goals; provider threads remain private execution contexts.
CREATE TABLE main_messages(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')), kind TEXT NOT NULL,
  body TEXT NOT NULL, reply_to TEXT REFERENCES main_messages(id),
  origin TEXT UNIQUE, created TEXT NOT NULL
);
CREATE TABLE main_refs(message_id TEXT REFERENCES main_messages(id),
  goal_id TEXT REFERENCES goals(id), PRIMARY KEY(message_id,goal_id));
CREATE TABLE main_tasks(goal_id TEXT PRIMARY KEY REFERENCES goals(id),
  mode TEXT NOT NULL CHECK(mode IN ('work','reminder','trending')), cadence TEXT NOT NULL,
  clock TEXT NOT NULL, next_at TEXT, notify TEXT NOT NULL,
  attempted TEXT, succeeded TEXT, last_note TEXT, failures INTEGER NOT NULL DEFAULT 0);
CREATE INDEX main_due ON main_tasks(next_at) WHERE next_at IS NOT NULL;
CREATE TABLE main_observations(goal_id TEXT REFERENCES goals(id), slot TEXT NOT NULL,
  checked TEXT NOT NULL, source TEXT NOT NULL, snapshot TEXT NOT NULL, preferences TEXT NOT NULL, PRIMARY KEY(goal_id,slot));
CREATE TABLE main_notified(goal_id TEXT REFERENCES goals(id), item TEXT NOT NULL,
  message_id TEXT NOT NULL REFERENCES main_messages(id), PRIMARY KEY(goal_id,item));
-- Import existing final replies once as historical context, not new notifications.
INSERT INTO main_messages(id,role,kind,body,origin,created)
SELECT m.id,'assistant','history',m.title,'run:'||r.id,r.finished
FROM agent_runs r JOIN raw_events m ON m.seq=(SELECT max(x.seq) FROM raw_events x
 WHERE x.run_id=r.id AND x.type='agent.message' AND x.received<=r.finished)
WHERE r.status='succeeded' ORDER BY r.finished;
INSERT INTO main_refs SELECT m.id,r.goal_id FROM main_messages m
JOIN agent_runs r ON m.origin='run:'||r.id;
CREATE TABLE main_run_scope(run_id TEXT PRIMARY KEY REFERENCES agent_runs(id), constraints_json TEXT NOT NULL);
ALTER TABLE attention_cursors ADD COLUMN main_seq INTEGER NOT NULL DEFAULT 0;
