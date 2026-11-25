-- Preserve existing project grants, including disabled ones. A private task
-- directory is only a project if the user explicitly registers it.
CREATE TABLE authorized_projects (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id)
);
INSERT INTO authorized_projects
SELECT w.id FROM workspaces w
WHERE NOT EXISTS (SELECT 1 FROM managed_commissions m WHERE m.workspace_id=w.id)
  AND NOT EXISTS (SELECT 1 FROM goals g JOIN agent_runs r ON r.goal_id=g.id
                  WHERE g.workspace_id=w.id AND r.key='demo-seed');

CREATE TABLE main_project_questions (
  message_id TEXT PRIMARY KEY REFERENCES main_messages(id),
  request_id TEXT NOT NULL REFERENCES main_messages(id),
  intent TEXT NOT NULL,
  asked_at TEXT NOT NULL,
  resolved_by TEXT REFERENCES main_messages(id),
  decision TEXT
);
