CREATE TABLE users (
  id TEXT PRIMARY KEY,
  wechat_openid TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE memberships (
  project_id TEXT NOT NULL REFERENCES projects(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK(role IN ('owner', 'viewer')),
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE project_records (
  project_id TEXT NOT NULL REFERENCES projects(id),
  collection TEXT NOT NULL CHECK(collection IN ('projects', 'shootDays', 'projectSchedules', 'projectCrewGroups', 'projectCrewMembers', 'projectCrewMemberships', 'records', 'translations', 'locations', 'itineraryDays', 'itineraryStops', 'timelineEvents', 'transfers', 'itineraryPublications', 'independentArtifacts')),
  id TEXT NOT NULL,
  data_json TEXT NOT NULL,
  revision INTEGER NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY (project_id, collection, id)
);

CREATE TABLE project_changes (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  collection TEXT NOT NULL,
  record_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('upsert', 'delete')),
  revision INTEGER NOT NULL
);

CREATE INDEX project_changes_by_project_cursor ON project_changes(project_id, cursor);

CREATE TABLE browser_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  expires_at TEXT NOT NULL
);

CREATE TABLE pairings (
  id TEXT PRIMARY KEY,
  browser_session_id TEXT NOT NULL REFERENCES browser_sessions(id),
  expires_at TEXT NOT NULL,
  confirmed_at TEXT
);

CREATE TABLE invitations (
  code TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  expires_at TEXT NOT NULL,
  accepted_at TEXT
);

CREATE TRIGGER project_records_after_insert
AFTER INSERT ON project_records
BEGIN
  INSERT INTO project_changes (project_id, collection, record_id, operation, revision)
  VALUES (NEW.project_id, NEW.collection, NEW.id, CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'delete' END, NEW.revision);
END;

CREATE TRIGGER project_records_after_update
AFTER UPDATE OF data_json, revision, deleted_at ON project_records
BEGIN
  INSERT INTO project_changes (project_id, collection, record_id, operation, revision)
  VALUES (NEW.project_id, NEW.collection, NEW.id, CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'delete' END, NEW.revision);
END;
