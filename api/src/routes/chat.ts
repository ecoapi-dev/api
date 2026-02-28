import { Hono } from "hono";
import type { AppContext } from "../env";
import { AppError } from "../utils/app-error";

const app = new Hono<AppContext>();

app.post("/chat", async (c) => {
  const body = await c.req.json().catch(() => {
    throw new AppError("MALFORMED_JSON", "Malformed JSON request body", 400);
  });

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new AppError("VALIDATION_ERROR", "Invalid chat payload", 422, {
      fields: [{ field: "messages", message: "messages is required and must be a non-empty array." }],
    });
  }

  const result = await c.env.AI.run("@cf/meta/llama-3.1-8b-instruct-fp8", {
    messages: body.messages as { role: string; content: string }[],
  });

  return c.json({ data: result });
});

export default app;
