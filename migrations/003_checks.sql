CREATE TABLE criterion_checks(goal_id TEXT REFERENCES goals,criterion TEXT NOT NULL,checked_at TEXT NOT NULL,PRIMARY KEY(goal_id,criterion));

