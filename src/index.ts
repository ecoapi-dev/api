import { Hono } from "hono";
import type { AppContext } from "./env";
import { corsMiddleware } from "./middleware/cors";
import { requestIdMiddleware } from "./middleware/request-id";
import { requestLoggingMiddleware } from "./middleware/logging";
import { requireJsonContentType } from "./middleware/content-type";
import { errorHandler, notFoundHandler } from "./middleware/error-handler";
import { scanRateLimitMiddleware } from "./middleware/rate-limit";
import { requireAdminKey } from "./middleware/auth";
import healthRoutes from "./routes/health";
import projectRoutes from "./routes/projects";
import providerRoutes from "./routes/providers";
import chatRoutes from "./routes/chat";
import telemetryRoutes from "./routes/telemetry";
import { runRollup } from "./services/rollup-service";
import type { Env } from "./env";

const app = new Hono<AppContext>();

app.use("*", corsMiddleware);
app.use("*", requestIdMiddleware);
app.use("*", requestLoggingMiddleware);
app.use("*", requireJsonContentType);
app.on(["POST"], "/projects", requireAdminKey);
app.on(["GET"], "/projects", requireAdminKey);
app.on(["PATCH"], "/projects/:id", requireAdminKey);
app.on(["DELETE"], "/projects/:id", requireAdminKey);
app.on(["POST"], "/projects/:id/scans", requireAdminKey);
app.post("/projects/:id/scans", scanRateLimitMiddleware);

app.get("/", (c) =>
  c.json({
    data: {
      name: "API Usage Analyzer",
      message: "API is running.",
      resources: ["/health", "/projects", "/providers"]
    }
  })
);

app.route("/", healthRoutes);
app.route("/", projectRoutes);
app.route("/", providerRoutes);
app.route("/", chatRoutes);
app.route("/", telemetryRoutes);

app.notFound(notFoundHandler);
app.onError(errorHandler);

const handleScheduled = async (_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> => {
  try {
    const summary = await runRollup(env.DB);
    console.log(
      `[cron] rollup complete — ${summary.projects} project(s), ` +
      `${summary.daysRolledUp} day-groups upserted, ` +
      `${summary.windowsPruned} old metric rows pruned`
    );
  } catch (err) {
    console.error("[cron] rollup failed:", err);
  }
};

export default {
  fetch: app.fetch,
  scheduled: handleScheduled,
};
