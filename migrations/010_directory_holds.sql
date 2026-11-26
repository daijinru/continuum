-- Keep the original queue entry or schedule slot intact until the user
-- restores its directory or confirms a new one. Automatic restoration has
-- a resolution time but no user message.
CREATE TABLE directory_holds (
  notice_id TEXT PRIMARY KEY REFERENCES main_messages(id),
  goal_id TEXT NOT NULL REFERENCES goals(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  reason TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT REFERENCES main_messages(id),
  replacement_path TEXT
);
CREATE UNIQUE INDEX one_directory_hold ON directory_holds(goal_id) WHERE resolved_at IS NULL;

CREATE VIEW dispatchable_goals AS
SELECT g.id FROM goals g JOIN workspaces w ON w.id=g.workspace_id
WHERE g.state='active' AND w.enabled=1 AND NOT EXISTS (
  SELECT 1 FROM directory_holds h WHERE h.goal_id=g.id AND h.resolved_at IS NULL
);
