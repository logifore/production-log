CREATE TABLE IF NOT EXISTS support_ticket_rate_limits (
  user_id TEXT PRIMARY KEY,
  window_started_at INTEGER NOT NULL,
  request_count INTEGER NOT NULL
);
