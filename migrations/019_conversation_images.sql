CREATE TABLE conversation_images(
  id TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  bytes BLOB NOT NULL,
  created TEXT NOT NULL,
  message_id TEXT REFERENCES main_messages(id),
  position INTEGER,
  UNIQUE(message_id,position)
);
