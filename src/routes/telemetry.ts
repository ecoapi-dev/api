import { Hono } from "hono";
import type { AppContext } from "../env";
import { AppError } from "../utils/app-error";
import { validateTelemetryInput } from "../services/validation-service";
import { getAnalytics, ingestTelemetry } from "../services/telemetry-service";

const app = new Hono<AppContext>();

app.post("/projects/:id/telemetry", async (c) => {
  const body = await c.req.json().catch(() => {
    throw new AppError("MALFORMED_JSON", "Malformed JSON request body", 400);
  });

  const input = validateTelemetryInput(body);
  const windowId = await ingestTelemetry(c.env.DB, c.req.param("id"), input);

  return c.json({ status: "accepted", windowId }, 202);
});

app.get("/projects/:id/analytics", async (c) => {
  const query = c.req.query();

  if (!query.from || !query.to) {
    throw new AppError("VALIDATION_ERROR", "Query params 'from' and 'to' are required", 422, {
      fields: [
        ...(!query.from ? [{ field: "from", message: "from is required." }] : []),
        ...(!query.to ? [{ field: "to", message: "to is required." }] : [])
      ]
    });
  }

  const fromDate = new Date(query.from);
  const toDate = new Date(query.to);

  if (isNaN(fromDate.getTime())) {
    throw new AppError("VALIDATION_ERROR", "Invalid analytics query params", 422, {
      fields: [{ field: "from", message: "from must be a valid ISO 8601 date string." }]
    });
  }
  if (isNaN(toDate.getTime())) {
    throw new AppError("VALIDATION_ERROR", "Invalid analytics query params", 422, {
      fields: [{ field: "to", message: "to must be a valid ISO 8601 date string." }]
    });
  }
  if (toDate <= fromDate) {
    throw new AppError("VALIDATION_ERROR", "Invalid analytics query params", 422, {
      fields: [{ field: "to", message: "to must be after from." }]
    });
  }

  const interval = query.interval === "window" ? "window" : "day";

  const result = await getAnalytics(c.env.DB, c.req.param("id"), {
    from: query.from,
    to: query.to,
    interval,
    ...(query.environment !== undefined ? { environment: query.environment } : {}),
    ...(query.provider !== undefined ? { provider: query.provider } : {})
  });

  return c.json({ data: result });
});

export default app;
