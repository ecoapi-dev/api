import {
  EndpointCallSite,
  EndpointRecord,
  EndpointStatus,
  GraphData,
  Project,
  ProjectInput,
  ProjectPatchInput,
  Scan,
  ScanSummary,
  Suggestion,
  SuggestionType,
  SustainabilityProviderBreakdown,
  SustainabilityStats
} from "../models/types";
import { notFound, AppError } from "../utils/app-error";
import { analyzeApiCalls } from "./analysis-service";
import {
  AI_PROVIDERS,
  CO2_GRAMS_PER_KWH,
  DEFAULT_AI_ENERGY_KWH,
  DEFAULT_REGULAR_ENERGY_KWH,
  ENERGY_PER_CALL_KWH,
  WATER_LITERS_PER_KWH
} from "../config/sustainability";

// ---------------------------------------------------------------------------
// Raw DB row types (snake_case columns, JSON strings for arrays/objects)
// ---------------------------------------------------------------------------

interface RawProject {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  latest_scan_id: string | null;
}

interface RawScan {
  id: string;
  project_id: string;
  created_at: string;
  endpoint_ids: string;
  suggestion_ids: string;
  graph: string;
  summary: string;
}

interface RawEndpoint {
  id: string;
  project_id: string;
  scan_id: string;
  provider: string;
  method: string;
  url: string;
  files: string;
  call_sites: string;
  calls_per_day: number;
  monthly_cost: number;
  status: string;
}

interface RawSuggestion {
  id: string;
  project_id: string;
  scan_id: string;
  type: string;
  severity: string;
  affected_endpoints: string;
  affected_files: string;
  estimated_monthly_savings: number;
  description: string;
  code_fix: string;
}

// ---------------------------------------------------------------------------
// Row → Domain converters
// ---------------------------------------------------------------------------

const toProject = (row: RawProject): Project => ({
  id: row.id,
  name: row.name,
  ...(row.description !== null ? { description: row.description } : {}),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  ...(row.latest_scan_id !== null ? { latestScanId: row.latest_scan_id } : {})
});

const toScan = (row: RawScan): Scan => ({
  id: row.id,
  projectId: row.project_id,
  createdAt: row.created_at,
  endpointIds: JSON.parse(row.endpoint_ids) as string[],
  suggestionIds: JSON.parse(row.suggestion_ids) as string[],
  graph: JSON.parse(row.graph) as GraphData,
  summary: JSON.parse(row.summary) as ScanSummary
});

const toEndpoint = (row: RawEndpoint): EndpointRecord => ({
  id: row.id,
  projectId: row.project_id,
  scanId: row.scan_id,
  provider: row.provider,
  method: row.method,
  url: row.url,
  files: JSON.parse(row.files) as string[],
  callSites: JSON.parse(row.call_sites) as EndpointCallSite[],
  callsPerDay: row.calls_per_day,
  monthlyCost: row.monthly_cost,
  status: row.status as EndpointStatus
});

const toSuggestion = (row: RawSuggestion): Suggestion => ({
  id: row.id,
  projectId: row.project_id,
  scanId: row.scan_id,
  type: row.type as SuggestionType,
  severity: row.severity as "high" | "medium" | "low",
  affectedEndpoints: JSON.parse(row.affected_endpoints) as string[],
  affectedFiles: JSON.parse(row.affected_files) as string[],
  estimatedMonthlySavings: row.estimated_monthly_savings,
  description: row.description,
  codeFix: row.code_fix
});

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export const createProject = async (db: D1Database, input: ProjectInput): Promise<Project> => {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await db
    .prepare("INSERT INTO projects (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, input.name, input.description ?? null, now, now)
    .run();

  if (input.apiCalls && input.apiCalls.length > 0) {
    const scan = await createScanInternal(db, id, input.apiCalls);
    await db
      .prepare("UPDATE projects SET latest_scan_id = ?, updated_at = ? WHERE id = ?")
      .bind(scan.id, new Date().toISOString(), id)
      .run();
  }

  return getProject(db, id);
};

export const listProjects = async (
  db: D1Database,
  { name, sort, order }: { name?: string; sort?: string; order: "asc" | "desc" }
): Promise<Project[]> => {
  const validSortFields: Record<string, string> = {
    created_at: "created_at",
    updated_at: "updated_at",
    name: "name"
  };
  const sortField = sort ?? "created_at";
  if (!validSortFields[sortField]) {
    throw new AppError(
      "INVALID_SORT_FIELD",
      "Query param 'sort' must be one of: created_at, updated_at, name",
      422
    );
  }

  const col = validSortFields[sortField];
  const dir = order === "asc" ? "ASC" : "DESC";

  let rows: RawProject[];
  if (name) {
    const result = await db
      .prepare(`SELECT * FROM projects WHERE name LIKE ? ORDER BY ${col} ${dir}`)
      .bind(`%${name}%`)
      .all<RawProject>();
    rows = result.results ?? [];
  } else {
    const result = await db
      .prepare(`SELECT * FROM projects ORDER BY ${col} ${dir}`)
      .all<RawProject>();
    rows = result.results ?? [];
  }

  return rows.map(toProject);
};

export const getProject = async (db: D1Database, projectId: string): Promise<Project> => {
  const row = await db
    .prepare("SELECT * FROM projects WHERE id = ?")
    .bind(projectId)
    .first<RawProject>();
  if (!row) throw notFound("Project", projectId);
  return toProject(row);
};

export const getProjectWithSummary = async (
  db: D1Database,
  projectId: string
): Promise<Project & { summary: Record<string, number> }> => {
  const project = await getProject(db, projectId);

  const countRow = await db
    .prepare("SELECT COUNT(*) as count FROM scans WHERE project_id = ?")
    .bind(projectId)
    .first<{ count: number }>();

  let latestSummary: ScanSummary | undefined;
  if (project.latestScanId) {
    const scanRow = await db
      .prepare("SELECT summary FROM scans WHERE id = ?")
      .bind(project.latestScanId)
      .first<{ summary: string }>();
    if (scanRow) latestSummary = JSON.parse(scanRow.summary) as ScanSummary;
  }

  return {
    ...project,
    summary: {
      scans: countRow?.count ?? 0,
      endpoints: latestSummary?.totalEndpoints ?? 0,
      callsPerDay: latestSummary?.totalCallsPerDay ?? 0,
      monthlyCost: latestSummary?.totalMonthlyCost ?? 0
    }
  };
};

export const patchProject = async (
  db: D1Database,
  projectId: string,
  input: ProjectPatchInput
): Promise<Project> => {
  await getProject(db, projectId);
  const now = new Date().toISOString();
  const setClauses: string[] = ["updated_at = ?"];
  const bindings: unknown[] = [now];

  if (input.name !== undefined) {
    setClauses.push("name = ?");
    bindings.push(input.name);
  }
  if (input.description !== undefined) {
    setClauses.push("description = ?");
    bindings.push(input.description);
  }
  bindings.push(projectId);

  await db
    .prepare(`UPDATE projects SET ${setClauses.join(", ")} WHERE id = ?`)
    .bind(...bindings)
    .run();

  return getProject(db, projectId);
};

export const deleteProject = async (db: D1Database, projectId: string): Promise<void> => {
  await getProject(db, projectId);
  await db.batch([
    db.prepare("DELETE FROM suggestions WHERE project_id = ?").bind(projectId),
    db.prepare("DELETE FROM endpoints WHERE project_id = ?").bind(projectId),
    db.prepare("DELETE FROM scans WHERE project_id = ?").bind(projectId),
    db.prepare("DELETE FROM projects WHERE id = ?").bind(projectId)
  ]);
};

// ---------------------------------------------------------------------------
// Scans
// ---------------------------------------------------------------------------

const createScanInternal = async (
  db: D1Database,
  projectId: string,
  apiCalls: NonNullable<ProjectInput["apiCalls"]>
): Promise<Scan> => {
  const scanId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const result = analyzeApiCalls(projectId, scanId, apiCalls);

  const statements = [
    db
      .prepare(
        "INSERT INTO scans (id, project_id, created_at, endpoint_ids, suggestion_ids, graph, summary) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .bind(
        scanId,
        projectId,
        createdAt,
        JSON.stringify(result.endpoints.map((e) => e.id)),
        JSON.stringify(result.suggestions.map((s) => s.id)),
        JSON.stringify(result.graph),
        JSON.stringify(result.summary)
      ),
    ...result.endpoints.map((ep) =>
      db
        .prepare(
          "INSERT INTO endpoints (id, project_id, scan_id, provider, method, url, files, call_sites, calls_per_day, monthly_cost, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(
          ep.id,
          ep.projectId,
          ep.scanId,
          ep.provider,
          ep.method,
          ep.url,
          JSON.stringify(ep.files),
          JSON.stringify(ep.callSites),
          ep.callsPerDay,
          ep.monthlyCost,
          ep.status
        )
    ),
    ...result.suggestions.map((sg) =>
      db
        .prepare(
          "INSERT INTO suggestions (id, project_id, scan_id, type, severity, affected_endpoints, affected_files, estimated_monthly_savings, description, code_fix) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(
          sg.id,
          sg.projectId,
          sg.scanId,
          sg.type,
          sg.severity,
          JSON.stringify(sg.affectedEndpoints),
          JSON.stringify(sg.affectedFiles),
          sg.estimatedMonthlySavings,
          sg.description,
          sg.codeFix
        )
    )
  ];

  await db.batch(statements);

  return {
    id: scanId,
    projectId,
    createdAt,
    endpointIds: result.endpoints.map((e) => e.id),
    suggestionIds: result.suggestions.map((s) => s.id),
    graph: result.graph,
    summary: result.summary
  };
};

export const createScan = async (
  db: D1Database,
  projectId: string,
  apiCalls: ProjectInput["apiCalls"]
): Promise<Scan> => {
  await getProject(db, projectId);
  const scan = await createScanInternal(db, projectId, apiCalls ?? []);
  await db
    .prepare("UPDATE projects SET latest_scan_id = ?, updated_at = ? WHERE id = ?")
    .bind(scan.id, new Date().toISOString(), projectId)
    .run();
  return scan;
};

export const listScans = async (db: D1Database, projectId: string): Promise<Scan[]> => {
  await getProject(db, projectId);
  const result = await db
    .prepare("SELECT * FROM scans WHERE project_id = ? ORDER BY created_at DESC")
    .bind(projectId)
    .all<RawScan>();
  return (result.results ?? []).map(toScan);
};

export const getScan = async (db: D1Database, projectId: string, scanId: string): Promise<Scan> => {
  await getProject(db, projectId);
  const row = await db
    .prepare("SELECT * FROM scans WHERE id = ? AND project_id = ?")
    .bind(scanId, projectId)
    .first<RawScan>();
  if (!row) throw notFound("Scan", scanId);
  return toScan(row);
};

export const getLatestScan = async (db: D1Database, projectId: string): Promise<Scan> => {
  const project = await getProject(db, projectId);
  if (!project.latestScanId) {
    throw new AppError("RESOURCE_NOT_FOUND", `No scans found for project '${projectId}'`, 404);
  }
  return getScan(db, projectId, project.latestScanId);
};

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export const listLatestEndpoints = async (db: D1Database, projectId: string): Promise<EndpointRecord[]> => {
  const latest = await getLatestScan(db, projectId);
  const result = await db
    .prepare("SELECT * FROM endpoints WHERE scan_id = ?")
    .bind(latest.id)
    .all<RawEndpoint>();
  return (result.results ?? []).map(toEndpoint);
};

export const getEndpoint = async (
  db: D1Database,
  projectId: string,
  endpointId: string
): Promise<EndpointRecord> => {
  const row = await db
    .prepare("SELECT * FROM endpoints WHERE id = ? AND project_id = ?")
    .bind(endpointId, projectId)
    .first<RawEndpoint>();
  if (!row) throw notFound("Endpoint", endpointId);
  return toEndpoint(row);
};

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

export const listLatestSuggestions = async (db: D1Database, projectId: string): Promise<Suggestion[]> => {
  const latest = await getLatestScan(db, projectId);
  const result = await db
    .prepare("SELECT * FROM suggestions WHERE scan_id = ?")
    .bind(latest.id)
    .all<RawSuggestion>();
  return (result.results ?? []).map(toSuggestion);
};

export const getSuggestion = async (
  db: D1Database,
  projectId: string,
  suggestionId: string
): Promise<Suggestion> => {
  const row = await db
    .prepare("SELECT * FROM suggestions WHERE id = ? AND project_id = ?")
    .bind(suggestionId, projectId)
    .first<RawSuggestion>();
  if (!row) throw notFound("Suggestion", suggestionId);
  return toSuggestion(row);
};

// ---------------------------------------------------------------------------
// Analytics & Graph
// ---------------------------------------------------------------------------

export const getGraph = async (db: D1Database, projectId: string, clusterBy?: string): Promise<GraphData> => {
  const latest = await getLatestScan(db, projectId);
  if (!clusterBy) return latest.graph;

  const validCluster = ["provider", "file", "cost"];
  if (!validCluster.includes(clusterBy)) {
    throw new AppError("INVALID_CLUSTER_BY", "Query param 'cluster_by' must be provider, file, or cost", 422);
  }

  if (clusterBy === "provider") return latest.graph;

  const nodes = latest.graph.nodes.map((node) => ({
    ...node,
    group:
      clusterBy === "cost"
        ? node.monthlyCost > 500
          ? "high-cost"
          : node.monthlyCost > 100
            ? "medium-cost"
            : "low-cost"
        : node.label
  }));

  return { nodes, edges: latest.graph.edges };
};

export const getCostSummary = async (
  db: D1Database,
  projectId: string
): Promise<{ totalMonthlyCost: number; totalCallsPerDay: number; endpointCount: number }> => {
  const endpoints = await listLatestEndpoints(db, projectId);
  return {
    totalMonthlyCost: Number(
      endpoints.reduce((sum, ep) => sum + ep.monthlyCost, 0).toFixed(4)
    ),
    totalCallsPerDay: Number(
      endpoints.reduce((sum, ep) => sum + ep.callsPerDay, 0).toFixed(2)
    ),
    endpointCount: endpoints.length
  };
};

export const getCostBreakdownByProvider = async (
  db: D1Database,
  projectId: string
): Promise<Array<{ provider: string; monthlyCost: number; callsPerDay: number; endpointCount: number }>> => {
  const endpoints = await listLatestEndpoints(db, projectId);
  const map = new Map<string, { monthlyCost: number; callsPerDay: number; endpointCount: number }>();

  for (const ep of endpoints) {
    const current = map.get(ep.provider) ?? { monthlyCost: 0, callsPerDay: 0, endpointCount: 0 };
    current.monthlyCost += ep.monthlyCost;
    current.callsPerDay += ep.callsPerDay;
    current.endpointCount += 1;
    map.set(ep.provider, current);
  }

  return Array.from(map.entries()).map(([provider, value]) => ({
    provider,
    monthlyCost: Number(value.monthlyCost.toFixed(4)),
    callsPerDay: Number(value.callsPerDay.toFixed(2)),
    endpointCount: value.endpointCount
  }));
};

export const getSustainabilityStats = async (
  db: D1Database,
  projectId: string
): Promise<SustainabilityStats> => {
  const endpoints = await listLatestEndpoints(db, projectId);

  const providerMap = new Map<string, { callsPerDay: number }>();
  for (const ep of endpoints) {
    const current = providerMap.get(ep.provider) ?? { callsPerDay: 0 };
    current.callsPerDay += ep.callsPerDay;
    providerMap.set(ep.provider, current);
  }

  let totalDailyKwh = 0;
  let totalAiCallsPerDay = 0;
  let totalCallsPerDay = 0;
  const byProvider: SustainabilityProviderBreakdown[] = [];

  for (const [provider, data] of providerMap.entries()) {
    const isAi = AI_PROVIDERS.has(provider);
    const energyPerCall =
      ENERGY_PER_CALL_KWH[provider] ?? (isAi ? DEFAULT_AI_ENERGY_KWH : DEFAULT_REGULAR_ENERGY_KWH);
    const dailyKwh = data.callsPerDay * energyPerCall;

    totalDailyKwh += dailyKwh;
    totalCallsPerDay += data.callsPerDay;
    if (isAi) totalAiCallsPerDay += data.callsPerDay;

    byProvider.push({
      provider,
      isAi,
      callsPerDay: Number(data.callsPerDay.toFixed(2)),
      dailyKwh: Number(dailyKwh.toFixed(6)),
      dailyWaterLiters: Number((dailyKwh * WATER_LITERS_PER_KWH).toFixed(6)),
      dailyCo2Grams: Number((dailyKwh * CO2_GRAMS_PER_KWH).toFixed(4))
    });
  }

  byProvider.sort((a, b) => b.dailyKwh - a.dailyKwh);

  return {
    electricity: {
      dailyKwh: Number(totalDailyKwh.toFixed(6)),
      monthlyKwh: Number((totalDailyKwh * 30).toFixed(4))
    },
    water: {
      dailyLiters: Number((totalDailyKwh * WATER_LITERS_PER_KWH).toFixed(6)),
      monthlyLiters: Number((totalDailyKwh * WATER_LITERS_PER_KWH * 30).toFixed(4))
    },
    co2: {
      dailyGrams: Number((totalDailyKwh * CO2_GRAMS_PER_KWH).toFixed(4)),
      monthlyGrams: Number((totalDailyKwh * CO2_GRAMS_PER_KWH * 30).toFixed(2))
    },
    aiCallsPerDay: Number(totalAiCallsPerDay.toFixed(2)),
    totalCallsPerDay: Number(totalCallsPerDay.toFixed(2)),
    aiCallsPercentage:
      totalCallsPerDay > 0
        ? Number(((totalAiCallsPerDay / totalCallsPerDay) * 100).toFixed(1))
        : 0,
    byProvider
  };
};

export const getCostBreakdownByFile = async (
  db: D1Database,
  projectId: string
): Promise<Array<{ file: string; monthlyCost: number; callsPerDay: number; endpointCount: number }>> => {
  const endpoints = await listLatestEndpoints(db, projectId);
  const map = new Map<string, { monthlyCost: number; callsPerDay: number; endpointCount: number }>();

  for (const ep of endpoints) {
    for (const file of ep.files) {
      const current = map.get(file) ?? { monthlyCost: 0, callsPerDay: 0, endpointCount: 0 };
      current.monthlyCost += ep.monthlyCost / ep.files.length;
      current.callsPerDay += ep.callsPerDay / ep.files.length;
      current.endpointCount += 1;
      map.set(file, current);
    }
  }

  return Array.from(map.entries()).map(([file, value]) => ({
    file,
    monthlyCost: Number(value.monthlyCost.toFixed(4)),
    callsPerDay: Number(value.callsPerDay.toFixed(2)),
    endpointCount: value.endpointCount
  }));
};

