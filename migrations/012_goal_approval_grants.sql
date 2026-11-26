CREATE TABLE goal_approval_grants (
  goal_id TEXT PRIMARY KEY REFERENCES goals(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  source TEXT NOT NULL UNIQUE REFERENCES inbox_items(id)
);
-- A grant takes effect only after its originating approval was delivered.
CREATE VIEW active_goal_approval_grants AS
  SELECT g.* FROM goal_approval_grants g JOIN inbox_items i ON i.id=g.source
  WHERE i.status='approved';

CREATE TRIGGER end_goal_approval AFTER UPDATE OF workspace_id,provider,state ON goals
WHEN OLD.workspace_id<>NEW.workspace_id OR OLD.provider<>NEW.provider OR NEW.state IN ('archived','completed')
BEGIN
  DELETE FROM goal_approval_grants WHERE goal_id=NEW.id;
END;
CREATE TRIGGER end_workspace_approvals AFTER UPDATE OF enabled,path ON workspaces
WHEN NEW.enabled=0 OR OLD.path<>NEW.path
BEGIN
  DELETE FROM goal_approval_grants WHERE workspace_id=NEW.id;
END;
CREATE INDEX pending_regular_approvals ON inbox_items(created) WHERE status='pending' AND allow_for_run=1;
