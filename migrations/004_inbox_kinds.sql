ALTER TABLE inbox_items ADD COLUMN kind TEXT NOT NULL DEFAULT 'approval' CHECK(kind IN('approval','input','decision'));
ALTER TABLE inbox_items ADD COLUMN blocking INTEGER NOT NULL DEFAULT 1 CHECK(blocking IN(0,1));
