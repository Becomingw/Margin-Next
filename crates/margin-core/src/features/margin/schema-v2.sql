CREATE TABLE IF NOT EXISTS reviewer (
 slot INTEGER PRIMARY KEY CHECK(slot=1), id TEXT NOT NULL UNIQUE, label TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS entity_owners (
 entity_id TEXT PRIMARY KEY, reviewer_id TEXT NOT NULL REFERENCES reviewer(id)
);
CREATE INDEX IF NOT EXISTS proposals_by_status ON proposals(status);
PRAGMA user_version = 2;
