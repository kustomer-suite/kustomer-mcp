import postgres from "postgres";

import { createDbHandler } from "./db-handler.js";
import { openAiEmbedder } from "./embed.js";
import { handleMcp, type EdgeOptions } from "./handler.js";

// Entry point for Supabase Edge Functions (Deno). Secrets, set with `supabase secrets set`:
//   DEMO_TOKEN       required: the token callers present
//   DEMO_FIXTURE     hard | basic: the bundled fixture (the default backend)
//   DEMO_BACKEND     db: answer from Postgres instead (needs the rest below); anything else: the fixture
//   DEMO_STORE_ID    the store whose rows the database holds
//   OPENAI_API_KEY   the key the query embedding uses (a key made for this sandbox, with a spending limit)
//   EMBEDDING_MODEL  the model the stored vectors were made with (default text-embedding-ada-002, as in production)
// SUPABASE_DB_URL is set by Supabase itself.
declare const Deno: { serve(h: (req: Request) => Response | Promise<Response>): void; env: { get(k: string): string | undefined } };

let backend: EdgeOptions["backend"];
function database(): EdgeOptions["backend"] {
  if (backend) return backend;
  const url = Deno.env.get("SUPABASE_DB_URL");
  const storeId = Deno.env.get("DEMO_STORE_ID");
  const key = Deno.env.get("OPENAI_API_KEY");
  if (!url || !storeId || !key) return undefined; // not configured: the caller falls back to the fixture
  const model = Deno.env.get("EMBEDDING_MODEL") ?? "text-embedding-ada-002";
  // One connection per isolate; prepare off so it also works through the pooler.
  const sql = postgres(url, { max: 1, prepare: false, idle_timeout: 20, connection: { search_path: "public,extensions" } });
  const token = "internal";
  backend = { token, storeId, handler: createDbHandler({ sql, storeId, token, embed: openAiEmbedder({ apiKey: key, model }), embeddingModel: model }) };
  return backend;
}

Deno.serve((req) => {
  const wantsDb = Deno.env.get("DEMO_BACKEND") === "db";
  const db = wantsDb ? database() : undefined;
  // Fail closed: asked for the database but not configured for it must not quietly answer from the fixture.
  if (wantsDb && !db) {
    return new Response(JSON.stringify({ success: false, error: "The database backend is not configured." }), { status: 503, headers: { "Content-Type": "application/json" } });
  }
  return handleMcp(req, {
    token: Deno.env.get("DEMO_TOKEN"),
    fixture: Deno.env.get("DEMO_FIXTURE") === "basic" ? "basic" : "hard",
    backend: db,
  });
});
