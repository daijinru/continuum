-- Only the goal explicitly selected in the composer belongs in a reply quote.
ALTER TABLE main_messages ADD COLUMN reply_goal TEXT REFERENCES goals(id);
CREATE INDEX main_messages_reply_goal ON main_messages(reply_goal) WHERE reply_goal IS NOT NULL;
CREATE TRIGGER chat_reply_goal_title AFTER UPDATE OF title ON goals WHEN OLD.title IS NOT NEW.title BEGIN
  INSERT OR REPLACE INTO conversation_changes(message_id) SELECT id FROM main_messages WHERE reply_goal=NEW.id;
END;
