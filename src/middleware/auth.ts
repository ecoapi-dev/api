import type { MiddlewareHandler } from "hono";
import type { AppContext } from "../env";
import { AppError } from "../utils/app-error";

export const requireAdminKey: MiddlewareHandler<AppContext> = async (c, next) => {
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || token !== c.env.ADMIN_API_KEY) {
    throw new AppError("UNAUTHORIZED", "Invalid or missing API key", 401);
  }
  await next();
};
