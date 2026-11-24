-- Only a newly allocated, goal-specific workspace is eligible for autonomous
-- execution. Existing grants and pending provider requests keep their semantics.
CREATE TABLE managed_commissions (
  goal_id TEXT PRIMARY KEY REFERENCES goals(id),
  workspace_id TEXT NOT NULL UNIQUE REFERENCES workspaces(id)
);
