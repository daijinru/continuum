-- Eligibility comes from the adapter that inspected the original request.
ALTER TABLE inbox_items ADD COLUMN allow_for_run INTEGER NOT NULL DEFAULT 0 CHECK(allow_for_run IN (0,1));
