# EcoAPI — API Reference

Base URL: `https://api.ecoapi.dev`

---

## Authentication

Some routes require an admin API key. Pass it as a Bearer token:

```
Authorization: Bearer <admin-key>
```

Routes marked 🔒 require this header. Routes marked 🌐 are public.

---

## Health

### 🌐 `GET /health`
Check if the API is up.

```bash
curl https://api.ecoapi.dev/health
```

---

## Projects

### 🔒 `POST /projects`
Create a new project.

```bash
curl -X POST https://api.ecoapi.dev/projects \
  -H "Authorization: Bearer <admin-key>" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-app", "description": "optional"}'
```

Response: `201` with the created project including its `id`.

---

### 🔒 `GET /projects`
List all projects.

```bash
curl https://api.ecoapi.dev/projects \
  -H "Authorization: Bearer <admin-key>"
```

---

### 🌐 `GET /projects/:id`
Get a single project.

```bash
curl https://api.ecoapi.dev/projects/<id>
```

---

### 🔒 `PATCH /projects/:id`
Update a project's name or description.

```bash
curl -X PATCH https://api.ecoapi.dev/projects/<id> \
  -H "Authorization: Bearer <admin-key>" \
  -H "Content-Type: application/json" \
  -d '{"name": "new-name"}'
```

---

### 🔒 `DELETE /projects/:id`
Delete a project and all its data.

```bash
curl -X DELETE https://api.ecoapi.dev/projects/<id> \
  -H "Authorization: Bearer <admin-key>"
```

---

## Telemetry (SDK → API)

### 🌐 `POST /projects/:id/telemetry`
Ingest a WindowSummary payload from the SDK. Called automatically by `@ecoapi/node` and `ecoapi` (Python) — you don't call this manually.

Returns `202 { "status": "accepted", "windowId": "..." }`.

---

### 🌐 `GET /projects/:id/analytics`
Aggregated usage data for dashboards. Grouped by day by default.

**Query params:**
| Param | Required | Description |
|---|---|---|
| `from` | ✅ | Start datetime, ISO 8601 |
| `to` | ✅ | End datetime, ISO 8601 |
| `interval` | — | `day` (default) or `window` |
| `environment` | — | Filter by environment string |
| `provider` | — | Filter by provider name |

```bash
curl "https://api.ecoapi.dev/projects/<id>/analytics?from=2026-03-01T00:00:00Z&to=2026-03-31T23:59:59Z"
```

---

### 🌐 `GET /projects/:id/telemetry/recent`
Raw recent flush windows. Useful for debugging or live feeds.

**Query params:**
| Param | Default | Max |
|---|---|---|
| `limit` | 10 | 50 |
| `environment` | — | — |

```bash
curl "https://api.ecoapi.dev/projects/<id>/telemetry/recent?limit=20"
```

---

## Scans (Static Analysis)

### 🔒 `POST /projects/:id/scans`
Submit a codebase scan for API call detection and cost estimation. Rate limited to 10 per 60 seconds per project.

---

### 🌐 `GET /projects/:id/scans`
List all scans for a project.

### 🌐 `GET /projects/:id/scans/latest`
Get the most recent scan.

### 🌐 `GET /projects/:id/scans/:scanId`
Get a specific scan by ID.

---

## Analysis Results

All read-only and public — requires a valid project ID (UUID).

| Endpoint | Description |
|---|---|
| `GET /projects/:id/endpoints` | Detected API endpoints |
| `GET /projects/:id/endpoints/:endpointId` | Single endpoint detail |
| `GET /projects/:id/suggestions` | Optimization suggestions |
| `GET /projects/:id/suggestions/:suggestionId` | Single suggestion |
| `GET /projects/:id/graph` | API call graph |
| `GET /projects/:id/sustainability` | Sustainability stats |
| `GET /projects/:id/cost` | Cost summary |
| `GET /projects/:id/cost/by-provider` | Cost broken down by provider |
| `GET /projects/:id/cost/by-file` | Cost broken down by file |
