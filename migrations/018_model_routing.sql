ALTER TABLE user_messages ADD COLUMN workload TEXT CHECK(workload IN ('light','standard','deep'));
ALTER TABLE main_tasks ADD COLUMN workload TEXT CHECK(workload IN ('light','standard','deep'));
CREATE TABLE model_calls (
  seq INTEGER PRIMARY KEY,
  source TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  workload TEXT NOT NULL,
  model TEXT,
  effort TEXT,
  fallback INTEGER NOT NULL DEFAULT 0,
  started TEXT NOT NULL,
  finished TEXT,
  total INTEGER,
  outcome TEXT NOT NULL DEFAULT 'running'
);
