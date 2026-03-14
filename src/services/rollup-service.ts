/**
 * rollup-service.ts
 *
 * Aggregates raw telemetry_windows + telemetry_metrics into telemetry_daily.
 * Called by the hourly cron trigger. Safe to run repeatedly — idempotent via
 * INSERT OR REPLACE keyed on the unique index
 * (project_id, environment, date, provider, endpoint, method).
 */

interface RollupRow {
  project_id: string;
  environment: string;
  date: string;
  provider: string;
  endpoint: string;
  method: string;
  request_count: number;
  error_count: number;
  avg_latency_ms: number;
  p95_latency_ms: number;
  total_request_bytes: number;
  total_response_bytes: number;
  total_cost_cents: number;
}

interface RollupSummary {
  projects: number;
  daysRolledUp: number;
  windowsPruned: number;
}

const PRUNE_AFTER_DAYS = 7;

export const runRollup = async (DB: D1Database): Promise<RollupSummary> => {
  // 1. Find all projects that have raw telemetry windows
  const { results: projectRows } = await DB.prepare(
    "SELECT DISTINCT project_id FROM telemetry_windows"
  ).all<{ project_id: string }>();

  let totalDays = 0;

  for (const { project_id } of projectRows) {
    // 2. Aggregate into daily summaries for this project
    const { results: rows } = await DB.prepare(`
      SELECT
        tw.project_id,
        tw.environment,
        DATE(tw.window_start)        AS date,
        tm.provider,
        tm.endpoint,
        tm.method,
        SUM(tm.request_count)        AS request_count,
        SUM(tm.error_count)          AS error_count,
        CASE WHEN SUM(tm.request_count) > 0
          THEN CAST(SUM(tm.total_latency_ms) AS INTEGER) / SUM(tm.request_count)
          ELSE 0
        END                          AS avg_latency_ms,
        MAX(tm.p95_latency_ms)       AS p95_latency_ms,
        SUM(tm.total_request_bytes)  AS total_request_bytes,
        SUM(tm.total_response_bytes) AS total_response_bytes,
        SUM(tm.estimated_cost_cents) AS total_cost_cents
      FROM telemetry_metrics tm
      JOIN telemetry_windows tw ON tm.window_id = tw.id
      WHERE tw.project_id = ?
      GROUP BY tw.project_id, tw.environment, DATE(tw.window_start),
               tm.provider, tm.endpoint, tm.method
    `).bind(project_id).all<RollupRow>();

    if (rows.length === 0) continue;

    // 3. Upsert each aggregated row — batch for a single roundtrip
    const upsertStmts = rows.map((r) =>
      DB.prepare(`
        INSERT OR REPLACE INTO telemetry_daily
          (id, project_id, environment, date, provider, endpoint, method,
           request_count, error_count, avg_latency_ms, p95_latency_ms,
           total_request_bytes, total_response_bytes, total_cost_cents)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        crypto.randomUUID(),
        r.project_id,
        r.environment,
        r.date,
        r.provider,
        r.endpoint,
        r.method,
        r.request_count,
        r.error_count,
        r.avg_latency_ms ?? 0,
        r.p95_latency_ms ?? 0,
        r.total_request_bytes ?? 0,
        r.total_response_bytes ?? 0,
        r.total_cost_cents
      )
    );

    await DB.batch(upsertStmts);
    totalDays += rows.length;
  }

  // 4. Prune raw data older than PRUNE_AFTER_DAYS days
  const cutoff = `datetime('now', '-${PRUNE_AFTER_DAYS} days')`;

  const { meta: metricsMeta } = await DB.prepare(`
    DELETE FROM telemetry_metrics
    WHERE window_id IN (
      SELECT id FROM telemetry_windows
      WHERE window_start < ${cutoff}
    )
  `).run();

  await DB.prepare(`
    DELETE FROM telemetry_windows WHERE window_start < ${cutoff}
  `).run();

  const windowsPruned = metricsMeta.changes ?? 0;

  return {
    projects: projectRows.length,
    daysRolledUp: totalDays,
    windowsPruned,
  };
};
