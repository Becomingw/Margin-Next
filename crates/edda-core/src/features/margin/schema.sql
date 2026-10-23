PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS document (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL,
 head TEXT NOT NULL REFERENCES revisions(id), baseline TEXT NOT NULL REFERENCES revisions(id),
 sequence INTEGER NOT NULL, round_start INTEGER NOT NULL DEFAULT 0,
 metadata TEXT NOT NULL, source TEXT
);
CREATE TABLE IF NOT EXISTS revisions (
 id TEXT PRIMARY KEY, parent TEXT REFERENCES revisions(id), body TEXT NOT NULL,
 hash TEXT NOT NULL, created_at TEXT NOT NULL, kind TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS proposals (
 id TEXT PRIMARY KEY, base TEXT NOT NULL REFERENCES revisions(id),
 target TEXT NOT NULL REFERENCES revisions(id), actor TEXT NOT NULL,
 agent TEXT, status TEXT NOT NULL CHECK(status IN ('pending','applied','dismissed')),
 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS suggestions (
 id TEXT PRIMARY KEY, proposal TEXT NOT NULL REFERENCES proposals(id),
 start INTEGER NOT NULL, end INTEGER NOT NULL, before_text TEXT NOT NULL, after_text TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS comparisons (
 baseline TEXT NOT NULL REFERENCES revisions(id), head TEXT NOT NULL REFERENCES revisions(id),
 proposal TEXT NOT NULL REFERENCES proposals(id), PRIMARY KEY(baseline,head)
);
CREATE TABLE IF NOT EXISTS decisions (
 id TEXT PRIMARY KEY, proposal TEXT REFERENCES proposals(id),
 old_head TEXT NOT NULL REFERENCES revisions(id), old_baseline TEXT NOT NULL REFERENCES revisions(id),
 new_head TEXT NOT NULL REFERENCES revisions(id), new_baseline TEXT NOT NULL REFERENCES revisions(id),
 kind TEXT NOT NULL, sequence INTEGER NOT NULL, selection TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS threads (
 id TEXT PRIMARY KEY, origin_revision TEXT NOT NULL REFERENCES revisions(id),
 anchor_revision TEXT NOT NULL REFERENCES revisions(id), payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS legacy_revisions (legacy_id TEXT PRIMARY KEY, revision TEXT NOT NULL REFERENCES revisions(id));
CREATE TABLE IF NOT EXISTS events (
 sequence INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS receipts (
 command_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, response TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS revisions_no_update BEFORE UPDATE ON revisions BEGIN SELECT RAISE(ABORT, 'immutable revision'); END;
CREATE TRIGGER IF NOT EXISTS revisions_no_delete BEFORE DELETE ON revisions BEGIN SELECT RAISE(ABORT, 'immutable revision'); END;
CREATE TRIGGER IF NOT EXISTS suggestions_no_update BEFORE UPDATE ON suggestions BEGIN SELECT RAISE(ABORT, 'immutable suggestion'); END;
CREATE TRIGGER IF NOT EXISTS suggestions_no_delete BEFORE DELETE ON suggestions BEGIN SELECT RAISE(ABORT, 'immutable suggestion'); END;
CREATE TRIGGER IF NOT EXISTS decisions_no_update BEFORE UPDATE ON decisions BEGIN SELECT RAISE(ABORT, 'immutable decision'); END;
CREATE TRIGGER IF NOT EXISTS decisions_no_delete BEFORE DELETE ON decisions BEGIN SELECT RAISE(ABORT, 'immutable decision'); END;
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'immutable event'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'immutable event'); END;
PRAGMA user_version = 1;
