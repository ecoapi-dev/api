import { Hono } from "hono";
import type { AppContext } from "../env";
import {
  createProject,
  createScan,
  deleteProject,
  getCostBreakdownByFile,
  getCostBreakdownByProvider,
  getCostSummary,
  getEndpoint,
  getGraph,
  getLatestScan,
  getProjectWithSummary,
  getScan,
  getSuggestion,
  getSustainabilityStats,
  listLatestEndpoints,
  listLatestSuggestions,
  listProjects,
  listScans,
  patchProject
} from "../services/project-service";
import {
  validateCreateProjectInput,
  validatePatchProjectInput,
  validateScanInput
} from "../services/validation-service";
import { buildPaginationMeta, paginate, parsePagination } from "../utils/pagination";
import { AppError } from "../utils/app-error";
import { parseOrder } from "../utils/sort";

const app = new Hono<AppContext>();

app.post("/projects", async (c) => {
  const body = await c.req.json().catch(() => {
    throw new AppError("MALFORMED_JSON", "Malformed JSON request body", 400);
  });
  const input = validateCreateProjectInput(body);
  const project = await createProject(c.env.DB, input);
  return c.json({ data: project }, 201);
});

app.get("/projects", async (c) => {
  const query = c.req.query();
  const { page, limit } = parsePagination(query);
  const order = parseOrder(query.order);
  const data = await listProjects(c.env.DB, {
    name: query.name,
    sort: query.sort,
    order
  });
  return c.json({
    data: paginate(data, page, limit),
    pagination: buildPaginationMeta(page, limit, data.length)
  });
});

app.get("/projects/:id", async (c) => {
  const project = await getProjectWithSummary(c.env.DB, c.req.param("id"));
  return c.json({ data: project });
});

app.patch("/projects/:id", async (c) => {
  const body = await c.req.json().catch(() => {
    throw new AppError("MALFORMED_JSON", "Malformed JSON request body", 400);
  });
  const input = validatePatchProjectInput(body);
  const project = await patchProject(c.env.DB, c.req.param("id"), input);
  return c.json({ data: project });
});

app.delete("/projects/:id", async (c) => {
  await deleteProject(c.env.DB, c.req.param("id"));
  return c.body(null, 204);
});

app.post("/projects/:id/scans", async (c) => {
  const body = await c.req.json().catch(() => {
    throw new AppError("MALFORMED_JSON", "Malformed JSON request body", 400);
  });
  const input = validateScanInput(body);
  const scan = await createScan(c.env.DB, c.req.param("id"), input.apiCalls);
  return c.json({ data: scan }, 201);
});

app.get("/projects/:id/scans", async (c) => {
  const query = c.req.query();
  const { page, limit } = parsePagination(query);
  const order = parseOrder(query.order ?? "desc");
  const sort = query.sort ?? "created_at";
  if (!["created_at"].includes(sort)) {
    throw new AppError("INVALID_SORT_FIELD", "Query param 'sort' must be created_at", 422);
  }
  const all = (await listScans(c.env.DB, c.req.param("id"))).sort((a, b) =>
    order === "asc" ? a.createdAt.localeCompare(b.createdAt) : b.createdAt.localeCompare(a.createdAt)
  );
  return c.json({
    data: paginate(all, page, limit),
    pagination: buildPaginationMeta(page, limit, all.length)
  });
});

app.get("/projects/:id/scans/latest", async (c) => {
  const scan = await getLatestScan(c.env.DB, c.req.param("id"));
  return c.json({ data: scan });
});

app.get("/projects/:id/scans/:scanId", async (c) => {
  const scan = await getScan(c.env.DB, c.req.param("id"), c.req.param("scanId"));
  return c.json({ data: scan });
});

app.get("/projects/:id/endpoints", async (c) => {
  const query = c.req.query();
  const { page, limit } = parsePagination(query);
  const order = parseOrder(query.order ?? "desc");
  const sort = query.sort ?? "monthly_cost";
  if (!["monthly_cost", "calls_per_day", "method", "provider"].includes(sort)) {
    throw new AppError(
      "INVALID_SORT_FIELD",
      "Query param 'sort' must be monthly_cost, calls_per_day, method, or provider",
      422
    );
  }

  let data = await listLatestEndpoints(c.env.DB, c.req.param("id"));

  if (query.provider) data = data.filter((item) => item.provider === query.provider);
  if (query.status) data = data.filter((item) => item.status === query.status);
  if (query.method) data = data.filter((item) => item.method === query.method.toUpperCase());

  data = data.sort((a, b) => {
    if (sort === "calls_per_day") return order === "asc" ? a.callsPerDay - b.callsPerDay : b.callsPerDay - a.callsPerDay;
    if (sort === "method") return order === "asc" ? a.method.localeCompare(b.method) : b.method.localeCompare(a.method);
    if (sort === "provider") return order === "asc" ? a.provider.localeCompare(b.provider) : b.provider.localeCompare(a.provider);
    return order === "asc" ? a.monthlyCost - b.monthlyCost : b.monthlyCost - a.monthlyCost;
  });

  return c.json({
    data: paginate(data, page, limit),
    pagination: buildPaginationMeta(page, limit, data.length)
  });
});

app.get("/projects/:id/endpoints/:endpointId", async (c) => {
  const endpoint = await getEndpoint(c.env.DB, c.req.param("id"), c.req.param("endpointId"));
  return c.json({ data: endpoint });
});

app.get("/projects/:id/suggestions", async (c) => {
  const query = c.req.query();
  const { page, limit } = parsePagination(query);
  const order = parseOrder(query.order ?? "desc");
  const sort = query.sort ?? "estimated_savings";
  if (!["estimated_savings", "severity", "type"].includes(sort)) {
    throw new AppError(
      "INVALID_SORT_FIELD",
      "Query param 'sort' must be estimated_savings, severity, or type",
      422
    );
  }

  let data = await listLatestSuggestions(c.env.DB, c.req.param("id"));

  if (query.type) {
    const types = query.type.split(",").map((t) => t.trim());
    data = data.filter((item) => types.includes(item.type));
  }
  if (query.severity) data = data.filter((item) => item.severity === query.severity);

  data = data.sort((a, b) => {
    if (sort === "severity") {
      const rank: Record<string, number> = { high: 3, medium: 2, low: 1 };
      return order === "asc" ? rank[a.severity] - rank[b.severity] : rank[b.severity] - rank[a.severity];
    }
    if (sort === "type") return order === "asc" ? a.type.localeCompare(b.type) : b.type.localeCompare(a.type);
    return order === "asc"
      ? a.estimatedMonthlySavings - b.estimatedMonthlySavings
      : b.estimatedMonthlySavings - a.estimatedMonthlySavings;
  });

  return c.json({
    data: paginate(data, page, limit),
    pagination: buildPaginationMeta(page, limit, data.length)
  });
});

app.get("/projects/:id/suggestions/:suggestionId", async (c) => {
  const suggestion = await getSuggestion(c.env.DB, c.req.param("id"), c.req.param("suggestionId"));
  return c.json({ data: suggestion });
});

app.get("/projects/:id/graph", async (c) => {
  const graph = await getGraph(c.env.DB, c.req.param("id"), c.req.query("cluster_by"));
  return c.json({ data: graph });
});

app.get("/projects/:id/sustainability", async (c) => {
  const stats = await getSustainabilityStats(c.env.DB, c.req.param("id"));
  return c.json({ data: stats });
});

app.get("/projects/:id/cost", async (c) => {
  const summary = await getCostSummary(c.env.DB, c.req.param("id"));
  return c.json({ data: summary });
});

app.get("/projects/:id/cost/by-provider", async (c) => {
  const query = c.req.query();
  const { page, limit } = parsePagination(query);
  const data = await getCostBreakdownByProvider(c.env.DB, c.req.param("id"));
  return c.json({
    data: paginate(data, page, limit),
    pagination: buildPaginationMeta(page, limit, data.length)
  });
});

app.get("/projects/:id/cost/by-file", async (c) => {
  const query = c.req.query();
  const { page, limit } = parsePagination(query);
  const data = await getCostBreakdownByFile(c.env.DB, c.req.param("id"));
  return c.json({
    data: paginate(data, page, limit),
    pagination: buildPaginationMeta(page, limit, data.length)
  });
});

export default app;
