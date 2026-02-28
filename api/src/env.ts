export type Env = { DB: D1Database; AI: Ai };
export type Variables = { requestId: string };
export type AppContext = { Bindings: Env; Variables: Variables };
