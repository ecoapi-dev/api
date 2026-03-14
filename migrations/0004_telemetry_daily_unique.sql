-- Add unique constraint on telemetry_daily to enable INSERT OR REPLACE upserts
-- from the hourly rollup cron trigger.
CREATE UNIQUE INDEX IF NOT EXISTS idx_telemetry_daily_unique
  ON telemetry_daily(project_id, environment, date, provider, endpoint, method);
