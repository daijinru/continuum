-- Keep one cursor per changed message, including edits to its projected state.
-- Existing installations begin with a complete first page and a cursor of zero.
CREATE TABLE conversation_changes (
  version INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL UNIQUE REFERENCES main_messages(id)
);
CREATE INDEX IF NOT EXISTS main_refs_goal ON main_refs(goal_id, message_id);
CREATE TRIGGER chat_message_insert AFTER INSERT ON main_messages BEGIN
  INSERT OR REPLACE INTO conversation_changes(message_id) VALUES(NEW.id);
END;
CREATE TRIGGER chat_ref_insert AFTER INSERT ON main_refs BEGIN
  INSERT OR REPLACE INTO conversation_changes(message_id) VALUES(NEW.message_id);
END;
CREATE TRIGGER chat_approval_status AFTER UPDATE OF status ON inbox_items
WHEN NEW.kind='approval' AND OLD.status IS NOT NEW.status BEGIN
  INSERT OR REPLACE INTO conversation_changes(message_id)
    SELECT id FROM main_messages WHERE origin='inbox:'||NEW.id;
END;
CREATE TRIGGER chat_project_answer AFTER UPDATE OF resolved_by ON main_project_questions BEGIN
  INSERT OR REPLACE INTO conversation_changes(message_id) VALUES(NEW.message_id);
END;
CREATE TRIGGER chat_directory_answer AFTER UPDATE OF resolved_at,resolved_by ON directory_holds BEGIN
  INSERT OR REPLACE INTO conversation_changes(message_id) VALUES(NEW.notice_id);
END;
CREATE TRIGGER chat_goal_title AFTER UPDATE OF title ON goals WHEN OLD.title IS NOT NEW.title BEGIN
  INSERT OR REPLACE INTO conversation_changes(message_id) SELECT message_id FROM main_refs WHERE goal_id=NEW.id;
END;
CREATE TRIGGER chat_goal_state AFTER UPDATE OF state ON goals WHEN OLD.state IS NOT NEW.state BEGIN
  INSERT OR REPLACE INTO conversation_changes(message_id) SELECT notice_id FROM directory_holds WHERE goal_id=NEW.id;
END;
CREATE TRIGGER chat_workspace_state AFTER UPDATE OF enabled,path ON workspaces
WHEN OLD.enabled IS NOT NEW.enabled OR OLD.path IS NOT NEW.path BEGIN
  INSERT OR REPLACE INTO conversation_changes(message_id) SELECT notice_id FROM directory_holds WHERE workspace_id=NEW.id;
END;
