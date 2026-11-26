ALTER TABLE inbox_items ADD COLUMN masked_command INTEGER NOT NULL DEFAULT 0 CHECK(masked_command IN (0,1));
CREATE INDEX pending_masked_commands ON inbox_items(created) WHERE status='pending' AND masked_command=1;

-- An existing grant is extended only after the user reviews a live command.
-- Revoking or invalidating the parent also removes its extension.
CREATE TABLE masked_command_grants (
  goal_id TEXT PRIMARY KEY REFERENCES goal_approval_grants(goal_id) ON DELETE CASCADE,
  source TEXT NOT NULL UNIQUE REFERENCES inbox_items(id)
);
CREATE VIEW active_masked_command_grants AS
  SELECT m.* FROM masked_command_grants m
  JOIN active_goal_approval_grants g ON g.goal_id=m.goal_id
  JOIN inbox_items i ON i.id=m.source WHERE i.status='approved';
