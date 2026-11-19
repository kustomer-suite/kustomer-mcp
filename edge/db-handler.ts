import type postgres from "postgres";

import type { FixtureHandler, HandlerOutput } from "../conformance/fake-api.js";

// The REST API the TypeScript server talks to, answered from Postgres (the `sandbox`
// schema, see supabase/migrations) instead of from memory. Same envelope and the same
// tenant rule as conformance/fake-api.ts and as the production API: a token sees one store.
//
// What comes back is the stored JSON of each row (the shape the API returns), so what
// production computes per request (unread, the 120-character preview) is computed when
// the rows are loaded. What is still computed here per request is what depends on the
// request: paging, filters, order, the `since` window, and the vector search.

type Sql = postgres.Sql;

export interface DbHandlerOptions {
  sql: Sql;
  storeId: string;
  token: string;
  embed(text: string): Promise<number[]>;
  embeddingModel: string; // the model `embed` uses; searches are refused if the stored vectors came from another
  searchesPerMinute?: number; // every search embeds the query with a paid API and the token is public
  now?: () => Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The production windows (ConversationsRepository.sinceCutoff): relative to now, on started_at.
export function sinceCutoff(since: string | undefined, now: Date): Date | undefined {
  const days = { "7days": 7, "30days": 30, "90days": 90 } as const;
  switch ((since ?? "").toLowerCase()) {
    case "today":
      return new Date(Math.floor(now.getTime() / 86_400_000) * 86_400_000);
    case "7days":
    case "30days":
    case "90days":
      return new Date(now.getTime() - days[(since ?? "").toLowerCase() as keyof typeof days] * 86_400_000);
  }
  return undefined;
}

export function createDbHandler(o: DbHandlerOptions): FixtureHandler {
  const { sql, storeId } = o;
  const now = o.now ?? (() => new Date());
  const limitPerMinute = o.searchesPerMinute ?? 20;
  let modelChecked = false;

  const deny = (): HandlerOutput => ({ status: 403, body: { success: false, error: "forbidden" } });
  const ok = (data: unknown): HandlerOutput => ({ status: 200, body: { success: true, data } });
  const fail = (status: number, error: string): HandlerOutput => ({ status, body: { success: false, error } });

  return async ({ method, path: p, query, authorization, body: rawBody }) => {
    if (authorization !== `Bearer ${o.token}`) return fail(401, "unauthorized");

    try {
      if (method === "GET" && p === "/api/v1/conversations") {
        if (query.store_id !== storeId) return deny();
        const limit = Number(query.limit ?? 20);
        const offset = Number(query.offset ?? 0);
        const cutoff = sinceCutoff(query.since, now());
        const channel = query.channel ?? null;
        const handover = query.handover_status ?? null;
        const where = sql`c.store_id = ${storeId}::uuid
          and (${channel}::text is null or c.channel = ${channel})
          and (${handover}::text is null or c.handover_status = ${handover})
          and (${cutoff ?? null}::timestamptz is null or c.started_at >= ${cutoff ?? null})`;
        const [{ n }] = (await sql`select count(*)::int as n from sandbox.conversations c where ${where}`) as unknown as [{ n: number }];
        const rows = (await sql`
          select c.body, (select count(*)::int from sandbox.messages m where m.conversation_id = c.id) as message_count
          from sandbox.conversations c where ${where}
          order by c.activity desc, c.id
          limit ${limit} offset ${offset}`) as unknown as Array<{ body: Record<string, unknown>; message_count: number }>;
        // ip_address and metadata are what the API returns and the server must not pass on; constants, never real values.
        const items = rows.map((r) => ({ ...r.body, message_count: r.message_count, ip_address: "203.0.113.7", metadata: { wa_id: "6281234567890" } }));
        return ok({ items, total: n, limit, offset });
      }

      const conv = p.match(/^\/api\/v1\/conversations\/([^/]+)$/);
      if (method === "GET" && conv) {
        const id = decodeURIComponent(conv[1]!);
        if (!UUID.test(id)) return fail(404, "Conversation not found");
        const rows = (await sql`select body from sandbox.conversations where id = ${id}::uuid and store_id = ${storeId}::uuid`) as unknown as Array<{ body: unknown }>;
        if (rows.length === 0) return fail(404, "Conversation not found");
        const messages = (await sql`select body from sandbox.messages where conversation_id = ${id}::uuid order by seq`) as unknown as Array<{ body: Record<string, unknown> }>;
        return ok({ conversation: rows[0]!.body, messages: messages.map((m) => ({ ...m.body, conversation_id: id })) });
      }

      if (method === "POST" && p === "/api/v1/knowledge-base/search") {
        const body = JSON.parse(rawBody || "{}") as { store_id?: string; query?: string; limit?: number };
        if (body.store_id !== storeId) return deny();
        const text = (body.query ?? "").trim();
        if (!text) return ok([]);

        // Vectors made by one model cannot be ranked against a query made by another: both
        // are 1536 wide, nothing would fail, the ranking would just be wrong.
        if (!modelChecked) {
          const m = (await sql`select value from sandbox.meta where key = 'embedding_model'`) as unknown as Array<{ value: string }>;
          if (m[0]?.value !== o.embeddingModel) return fail(503, `the stored vectors were made with ${m[0]?.value ?? "an unknown model"}, this function embeds with ${o.embeddingModel}`);
          modelChecked = true;
        }
        const [{ n }] = (await sql`select count(*)::int as n from sandbox.search_log where at > now() - interval '1 minute'`) as unknown as [{ n: number }];
        if (n >= limitPerMinute) return fail(429, "search rate limit reached, try again in a minute");
        await sql`insert into sandbox.search_log default values`;
        await sql`delete from sandbox.search_log where at < now() - interval '1 hour'`;

        let vec: number[];
        try {
          vec = await o.embed(text);
        } catch {
          return fail(502, "the embedding service is unavailable"); // the cause is not echoed: it can repeat a key
        }
        const literal = `[${vec.join(",")}]`;
        const limit = Math.min(Math.max(Number(body.limit ?? 5), 1), 20);
        const rows = (await sql`
          select chunk_text, title, kb_item_id, (1 - (embedding <=> ${literal}::vector))::float8 as similarity
          from sandbox.knowledge
          where store_id = ${storeId}::uuid and embedding is not null
          order by embedding <=> ${literal}::vector
          limit ${limit}`) as unknown as unknown[];
        return ok(rows);
      }

      const logs = p.match(/^\/api\/v1\/stores\/([^/]+)\/tool-execution-logs$/);
      if (method === "GET" && logs) {
        if (decodeURIComponent(logs[1]!) !== storeId) return deny();
        // Mirrors the real handler: conversation_id wins and ignores the rest.
        if (query.conversation_id) {
          if (!UUID.test(query.conversation_id)) return ok([]);
          const rows = (await sql`select body from sandbox.tool_logs where store_id = ${storeId}::uuid and conversation_id = ${query.conversation_id}::uuid order by created_at asc, id`) as unknown as Array<{ body: unknown }>;
          return ok(rows.map((r) => r.body));
        }
        const tool = query.tool_name ?? null;
        const limit = Number(query.limit ?? 100);
        const rows = (await sql`
          select body from sandbox.tool_logs
          where store_id = ${storeId}::uuid and (${tool}::text is null or tool_name = ${tool})
          order by created_at desc, id desc limit ${limit}`) as unknown as Array<{ body: unknown }>;
        return ok(rows.map((r) => r.body));
      }

      if (method === "GET" && p === "/api/v1/dashboard/quota") {
        if (query.store_id !== storeId) return deny();
        const q = (await sql`select value from sandbox.meta where key = 'quota'`) as unknown as Array<{ value: unknown }>;
        return q[0] ? ok(q[0].value) : fail(404, "not found");
      }

      return fail(404, "not found");
    } catch (e) {
      // The message of a database error can carry a connection string or a query: it stays in the log, not in the answer.
      console.error("[sandbox] database error:", (e as Error).message);
      return fail(500, "internal error");
    }
  };
}
