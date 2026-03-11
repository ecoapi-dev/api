import {
  AnalyticsDataRow,
  AnalyticsResponse,
  AnalyticsSummary,
  AnalyticsTopProvider,
  TelemetryWindowInput
} from "../models/types";
import { notFound } from "../utils/app-error";

// ---------------------------------------------------------------------------
// Raw DB row types
// ---------------------------------------------------------------------------

interface RawDailyRow {
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

interface RawWindowRow {
  window_start: string;
  window_end: string;
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

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

export const ingestTelemetry = async (
  DB: D1Database,
  projectId: string,
  input: TelemetryWindowInput
): Promise<string> => {
  const project = await DB.prepare("SELECT id FROM projects WHERE id = ?")
    .bind(projectId)
    .first<{ id: string }>();
  if (!project) throw notFound("Project", projectId);

  const windowId = crypto.randomUUID();

  const windowStmt = DB.prepare(
    `INSERT INTO telemetry_windows (id, project_id, environment, sdk_language, sdk_version, window_start, window_end)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    windowId,
    projectId,
    input.environment,
    input.sdkLanguage,
    input.sdkVersion,
    input.windowStart,
    input.windowEnd
  );

  const metricStmts = input.metrics.map((m) =>
    DB.prepare(
      `INSERT INTO telemetry_metrics
         (id, window_id, provider, endpoint, method,
          request_count, error_count, total_latency_ms,
          p50_latency_ms, p95_latency_ms,
          total_request_bytes, total_response_bytes, estimated_cost_cents)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      crypto.randomUUID(),
      windowId,
      m.provider,
      m.endpoint,
      m.method,
      m.requestCount,
      m.errorCount,
      m.totalLatencyMs,
      m.p50LatencyMs,
      m.p95LatencyMs,
      m.totalRequestBytes,
      m.totalResponseBytes,
      m.estimatedCostCents
    )
  );

  await DB.batch([windowStmt, ...metricStmts]);

  return windowId;
};

// ---------------------------------------------------------------------------
// Analytics queries
// ---------------------------------------------------------------------------

interface AnalyticsParams {
  from: string;
  to: string;
  interval: "day" | "window";
  environment?: string;
  provider?: string;
}

export const getAnalytics = async (
  DB: D1Database,
  projectId: string,
  params: AnalyticsParams
): Promise<AnalyticsResponse> => {
  const project = await DB.prepare("SELECT id FROM projects WHERE id = ?")
    .bind(projectId)
    .first<{ id: string }>();
  if (!project) throw notFound("Project", projectId);

  let data: AnalyticsDataRow[];

  if (params.interval === "day") {
    data = await queryDaily(DB, projectId, params);
    if (data.length === 0) {
      data = await queryDailyFallback(DB, projectId, params);
    }
  } else {
    data = await queryWindows(DB, projectId, params);
  }

  return {
    projectId,
    from: params.from,
    to: params.to,
    interval: params.interval,
    data,
    summary: buildSummary(data)
  };
};

// ---------------------------------------------------------------------------
// Private query helpers
// ---------------------------------------------------------------------------

const queryDaily = async (
  DB: D1Database,
  projectId: string,
  params: AnalyticsParams
): Promise<AnalyticsDataRow[]> => {
  const fromDate = params.from.substring(0, 10);
  const toDate = params.to.substring(0, 10);

  const clauses: string[] = [
    "project_id = ?",
    "date >= ?",
    "date <= ?"
  ];
  const binds: unknown[] = [projectId, fromDate, toDate];

  if (params.environment !== undefined) {
    clauses.push("environment = ?");
    binds.push(params.environment);
  }
  if (params.provider !== undefined) {
    clauses.push("provider = ?");
    binds.push(params.provider);
  }

  const sql = `
    SELECT date, provider, endpoint, method,
           request_count, error_count, avg_latency_ms, p95_latency_ms,
           total_request_bytes, total_response_bytes, total_cost_cents
    FROM telemetry_daily
    WHERE ${clauses.join(" AND ")}
    ORDER BY date ASC, provider ASC`;

  const { results } = await DB.prepare(sql)
    .bind(...binds)
    .all<RawDailyRow>();

  return results.map((r) => ({
    date: r.date,
    provider: r.provider,
    endpoint: r.endpoint,
    method: r.method,
    requestCount: r.request_count,
    errorCount: r.error_count,
    avgLatencyMs: r.avg_latency_ms ?? 0,
    p95LatencyMs: r.p95_latency_ms ?? 0,
    totalRequestBytes: r.total_request_bytes ?? 0,
    totalResponseBytes: r.total_response_bytes ?? 0,
    totalCostCents: r.total_cost_cents
  }));
};

const queryDailyFallback = async (
  DB: D1Database,
  projectId: string,
  params: AnalyticsParams
): Promise<AnalyticsDataRow[]> => {
  const clauses: string[] = [
    "tw.project_id = ?",
    "tw.window_start >= ?",
    "tw.window_end <= ?"
  ];
  const binds: unknown[] = [projectId, params.from, params.to];

  if (params.environment !== undefined) {
    clauses.push("tw.environment = ?");
    binds.push(params.environment);
  }
  if (params.provider !== undefined) {
    clauses.push("tm.provider = ?");
    binds.push(params.provider);
  }

  const sql = `
    SELECT DATE(tw.window_start) AS date,
           tm.provider, tm.endpoint, tm.method,
           SUM(tm.request_count)  AS request_count,
           SUM(tm.error_count)    AS error_count,
           CAST(SUM(tm.total_latency_ms) AS INTEGER) / NULLIF(SUM(tm.request_count), 0) AS avg_latency_ms,
           MAX(tm.p95_latency_ms) AS p95_latency_ms,
           SUM(tm.total_request_bytes)  AS total_request_bytes,
           SUM(tm.total_response_bytes) AS total_response_bytes,
           SUM(tm.estimated_cost_cents) AS total_cost_cents
    FROM telemetry_metrics tm
    JOIN telemetry_windows tw ON tm.window_id = tw.id
    WHERE ${clauses.join(" AND ")}
    GROUP BY date, tm.provider, tm.endpoint, tm.method
    ORDER BY date ASC, tm.provider ASC`;

  const { results } = await DB.prepare(sql)
    .bind(...binds)
    .all<RawDailyRow>();

  return results.map((r) => ({
    date: r.date,
    provider: r.provider,
    endpoint: r.endpoint,
    method: r.method,
    requestCount: r.request_count,
    errorCount: r.error_count,
    avgLatencyMs: r.avg_latency_ms ?? 0,
    p95LatencyMs: r.p95_latency_ms ?? 0,
    totalRequestBytes: r.total_request_bytes ?? 0,
    totalResponseBytes: r.total_response_bytes ?? 0,
    totalCostCents: r.total_cost_cents
  }));
};

const queryWindows = async (
  DB: D1Database,
  projectId: string,
  params: AnalyticsParams
): Promise<AnalyticsDataRow[]> => {
  const clauses: string[] = [
    "tw.project_id = ?",
    "tw.window_start >= ?",
    "tw.window_end <= ?"
  ];
  const binds: unknown[] = [projectId, params.from, params.to];

  if (params.environment !== undefined) {
    clauses.push("tw.environment = ?");
    binds.push(params.environment);
  }
  if (params.provider !== undefined) {
    clauses.push("tm.provider = ?");
    binds.push(params.provider);
  }

  const sql = `
    SELECT tw.window_start, tw.window_end,
           tm.provider, tm.endpoint, tm.method,
           tm.request_count, tm.error_count,
           CASE WHEN tm.request_count > 0
                THEN tm.total_latency_ms / tm.request_count
                ELSE 0 END AS avg_latency_ms,
           tm.p95_latency_ms,
           tm.total_request_bytes, tm.total_response_bytes,
           tm.estimated_cost_cents AS total_cost_cents
    FROM telemetry_metrics tm
    JOIN telemetry_windows tw ON tm.window_id = tw.id
    WHERE ${clauses.join(" AND ")}
    ORDER BY tw.window_start ASC, tm.provider ASC`;

  const { results } = await DB.prepare(sql)
    .bind(...binds)
    .all<RawWindowRow>();

  return results.map((r) => ({
    windowStart: r.window_start,
    windowEnd: r.window_end,
    provider: r.provider,
    endpoint: r.endpoint,
    method: r.method,
    requestCount: r.request_count,
    errorCount: r.error_count,
    avgLatencyMs: r.avg_latency_ms ?? 0,
    p95LatencyMs: r.p95_latency_ms ?? 0,
    totalRequestBytes: r.total_request_bytes ?? 0,
    totalResponseBytes: r.total_response_bytes ?? 0,
    totalCostCents: r.total_cost_cents
  }));
};

// ---------------------------------------------------------------------------
// Summary builder
// ---------------------------------------------------------------------------

const buildSummary = (data: AnalyticsDataRow[]): AnalyticsSummary => {
  const providerMap = new Map<string, { requestCount: number; costCents: number }>();

  let totalRequests = 0;
  let totalErrors = 0;
  let totalCostCents = 0;

  for (const row of data) {
    totalRequests += row.requestCount;
    totalErrors += row.errorCount;
    totalCostCents += row.totalCostCents;

    const existing = providerMap.get(row.provider);
    if (existing) {
      existing.requestCount += row.requestCount;
      existing.costCents += row.totalCostCents;
    } else {
      providerMap.set(row.provider, {
        requestCount: row.requestCount,
        costCents: row.totalCostCents
      });
    }
  }

  const topProviders: AnalyticsTopProvider[] = Array.from(providerMap.entries())
    .map(([provider, stats]) => ({ provider, ...stats }))
    .sort((a, b) => b.requestCount - a.requestCount)
    .slice(0, 10);

  return { totalRequests, totalErrors, totalCostCents, topProviders };
};
