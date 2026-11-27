CREATE TABLE conversation_log (
  seq INTEGER PRIMARY KEY, at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  stage TEXT NOT NULL, page_id TEXT, message_id TEXT, version INTEGER, client_at TEXT
);
-- Keep a durable mapping even when conversation_changes replaces a projection.
CREATE TRIGGER chat_log_version AFTER INSERT ON conversation_changes BEGIN
  INSERT INTO conversation_log(stage,message_id,version) VALUES('committed',NEW.message_id,NEW.version);
END;
CREATE TRIGGER chat_log_retention AFTER INSERT ON conversation_log WHEN NEW.seq % 256=0 BEGIN
  DELETE FROM conversation_log WHERE seq <= NEW.seq-20000;
END;
