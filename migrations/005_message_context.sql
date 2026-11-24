ALTER TABLE user_messages ADD COLUMN source_run TEXT REFERENCES agent_runs(id);
