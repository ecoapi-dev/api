export type Env = { DB: D1Database; AI: Ai; KV: KVNamespace; ADMIN_API_KEY: string };
export type Variables = { requestId: string };
export type AppContext = { Bindings: Env; Variables: Variables };
