ALTER TABLE browser_sessions ADD COLUMN platform TEXT NOT NULL DEFAULT 'web';
ALTER TABLE browser_sessions ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
ALTER TABLE browser_sessions ADD COLUMN last_seen_at TEXT NOT NULL DEFAULT '';
ALTER TABLE browser_sessions ADD COLUMN absolute_expires_at TEXT NOT NULL DEFAULT '';
ALTER TABLE browser_sessions ADD COLUMN revoked_at TEXT;

UPDATE browser_sessions
SET created_at = expires_at,
    last_seen_at = expires_at,
    absolute_expires_at = expires_at
WHERE created_at = '' OR last_seen_at = '' OR absolute_expires_at = '';

CREATE INDEX IF NOT EXISTS browser_sessions_by_user_active ON browser_sessions(user_id, revoked_at, expires_at);
