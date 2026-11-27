-- A finished execution can still be waiting for information from the user.
CREATE TABLE followup_questions (
  message_id TEXT PRIMARY KEY REFERENCES main_messages(id),
  run_id TEXT NOT NULL REFERENCES agent_runs(id),
  question TEXT NOT NULL,
  answer_id TEXT UNIQUE REFERENCES main_messages(id)
);
CREATE UNIQUE INDEX followup_waiting ON followup_questions(run_id) WHERE answer_id IS NULL;
CREATE INDEX followup_history ON followup_questions(run_id);
