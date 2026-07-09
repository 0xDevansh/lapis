-- Slice 23: Generalize devices table for unified Device model
ALTER TABLE devices ADD COLUMN kind TEXT NOT NULL DEFAULT 'plugin';
ALTER TABLE devices ADD COLUMN capabilities TEXT;
ALTER TABLE devices ADD COLUMN conflict_policy TEXT NOT NULL DEFAULT 'rebase';
ALTER TABLE devices ADD COLUMN sync_cursor TEXT;
