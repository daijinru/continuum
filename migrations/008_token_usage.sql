-- One cumulative provider snapshot per owned Codex thread or ephemeral exec.
CREATE TABLE token_usage (
  source TEXT PRIMARY KEY,
  goal_id TEXT REFERENCES goals(id),
  input INTEGER NOT NULL CHECK(input >= 0),
  output INTEGER NOT NULL CHECK(output >= 0),
  total INTEGER NOT NULL CHECK(total >= 0)
);
CREATE INDEX token_usage_goal ON token_usage(goal_id);
