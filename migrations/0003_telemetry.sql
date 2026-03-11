-- Stores one row per flush from an SDK instance (one 30-second window)
CREATE TABLE IF NOT EXISTS telemetry_windows (
  id           TEXT NOT NULL PRIMARY KEY,
  project_id   TEXT NOT NULL,
  environment  TEXT NOT NULL DEFAULT 'development',
  sdk_language TEXT NOT NULL DEFAULT 'node',
  sdk_version  TEXT NOT NULL DEFAULT '0.0.0',
  window_start TEXT NOT NULL,
  window_end   TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- Stores one row per provider/endpoint/method group within a window
CREATE TABLE IF NOT EXISTS telemetry_metrics (
  id                   TEXT NOT NULL PRIMARY KEY,
  window_id            TEXT NOT NULL,
  provider             TEXT NOT NULL,
  endpoint             TEXT NOT NULL,
  method               TEXT NOT NULL,
  request_count        INTEGER NOT NULL DEFAULT 0,
  error_count          INTEGER NOT NULL DEFAULT 0,
  total_latency_ms     INTEGER NOT NULL DEFAULT 0,
  p50_latency_ms       INTEGER          DEFAULT 0,
  p95_latency_ms       INTEGER          DEFAULT 0,
  total_request_bytes  INTEGER          DEFAULT 0,
  total_response_bytes INTEGER          DEFAULT 0,
  estimated_cost_cents REAL    NOT NULL DEFAULT 0,
  FOREIGN KEY (window_id) REFERENCES telemetry_windows(id) ON DELETE CASCADE
);

-- Rolled-up daily summaries for fast dashboard queries.
-- Populated by a scheduled worker (cron trigger) that compacts telemetry_metrics.
CREATE TABLE IF NOT EXISTS telemetry_daily (
  id                   TEXT    NOT NULL PRIMARY KEY,
  project_id           TEXT    NOT NULL,
  environment          TEXT    NOT NULL,
  date                 TEXT    NOT NULL,
  provider             TEXT    NOT NULL,
  endpoint             TEXT    NOT NULL,
  method               TEXT    NOT NULL,
  request_count        INTEGER NOT NULL DEFAULT 0,
  error_count          INTEGER NOT NULL DEFAULT 0,
  avg_latency_ms       INTEGER          DEFAULT 0,
  p95_latency_ms       INTEGER          DEFAULT 0,
  total_request_bytes  INTEGER          DEFAULT 0,
  total_response_bytes INTEGER          DEFAULT 0,
  total_cost_cents     REAL    NOT NULL DEFAULT 0,
  created_at           TEXT    NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_telemetry_windows_project
  ON telemetry_windows(project_id, window_start);

CREATE INDEX IF NOT EXISTS idx_telemetry_windows_created
  ON telemetry_windows(created_at);

CREATE INDEX IF NOT EXISTS idx_telemetry_metrics_window
  ON telemetry_metrics(window_id);

CREATE INDEX IF NOT EXISTS idx_telemetry_daily_project_date
  ON telemetry_daily(project_id, date, provider);

CREATE INDEX IF NOT EXISTS idx_telemetry_daily_lookup
  ON telemetry_daily(project_id, environment, date);
