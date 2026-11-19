import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import fixture from "./fixture.json" with { type: "json" };

export type Fixture = typeof fixture;
export { fixture };

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
}

export interface FakeApi {
  url: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

// A stand-in for the Kustomer Suite REST API, serving the fixture with the
// same response envelope and the same tenant rule: a token sees one store.
//
// `nearestAlways` mirrors what the real search does and a keyword filter does
// not: it never answers "nothing found". When no passage matches the query it
// still returns the nearest ones, at a similarity that looks like a weak match
// (the hosted tool returned about 0.74 for a nonsense query), so an agent has
// to decide for itself that the knowledge base does not cover the question.
export interface FakeApiOptions {
  nearestAlways?: boolean;
}

// The request as the handler sees it: no Node types, so the same code runs in a
// Node HTTP server (the conformance suite, the evaluation) and behind an
// injected `fetch` (the Supabase Edge Function, which cannot listen on a port).
export interface HandlerInput {
  method: string;
  path: string;
  query: Record<string, string>;
  authorization?: string;
  body: string;
}
export interface HandlerOutput {
  status: number;
  body: unknown;
}
export type FixtureHandler = (i: HandlerInput) => Promise<HandlerOutput>;

export function createFixtureHandler(fx: Fixture = fixture, opts: FakeApiOptions = {}): FixtureHandler {
  const storeId = fx.store.id;
  return async ({ method, path: p, query, authorization, body: rawBody }) => {
    if (authorization !== `Bearer ${fx.token}`) return { status: 401, body: { success: false, error: "unauthorized" } };

    const deny = (): HandlerOutput => ({ status: 403, body: { success: false, error: "forbidden" } });
    const ok = (data: unknown): HandlerOutput => ({ status: 200, body: { success: true, data } });

    if (method === "GET" && p === "/api/v1/conversations") {
      if (query.store_id !== storeId) return deny();
      let items = fx.conversations.filter((c) => c.store_id === storeId);
      if (query.channel) items = items.filter((c) => c.channel === query.channel);
      if (query.handover_status) items = items.filter((c) => c.handover_status === query.handover_status);
      items.sort((a, b) => activity(b).localeCompare(activity(a)));
      const limit = Number(query.limit ?? 20);
      const offset = Number(query.offset ?? 0);
      const page = items.slice(offset, offset + limit).map(({ messages, ...c }) => ({
        ...c,
        message_count: messages.length,
        ip_address: "203.0.113.7",
        metadata: { wa_id: "6281234567890" },
      }));
      return ok({ items: page, total: items.length, limit, offset });
    }

    const conv = p.match(/^\/api\/v1\/conversations\/([^/]+)$/);
    if (method === "GET" && conv) {
      const c = fx.conversations.find((x) => x.id === decodeURIComponent(conv[1]!));
      if (!c || c.store_id !== storeId) return { status: 404, body: { success: false, error: "Conversation not found" } };
      const { messages, ...rest } = c;
      return ok({ conversation: rest, messages: messages.map((m) => ({ ...m, conversation_id: c.id })) });
    }

    if (method === "POST" && p === "/api/v1/knowledge-base/search") {
      const body = JSON.parse(rawBody || "{}") as { store_id?: string; query?: string; limit?: number };
      if (body.store_id !== storeId) return deny();
      const words = (body.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const scored = fx.knowledge
        .filter((k) => k.store_id === storeId)
        .map((k) => {
          const text = `${k.title} ${k.chunk_text}`.toLowerCase();
          const hits = words.filter((w) => text.includes(w)).length;
          return { chunk_text: k.chunk_text, title: k.title, kb_item_id: k.kb_item_id, similarity: words.length ? hits / words.length : 0 };
        })
        .sort((a, b) => b.similarity - a.similarity);
      const matched = scored.filter((r) => r.similarity > 0);
      const rows = matched.length > 0 || !opts.nearestAlways ? matched : scored.map((r) => ({ ...r, similarity: 0.74 }));
      return ok(rows.slice(0, body.limit ?? 5));
    }

    const logs = p.match(/^\/api\/v1\/stores\/([^/]+)\/tool-execution-logs$/);
    if (method === "GET" && logs) {
      if (decodeURIComponent(logs[1]!) !== storeId) return deny();
      let rows = fx.toolLogs.filter((l) => l.store_id === storeId);
      // Mirrors the real handler: conversation_id wins and ignores the rest.
      if (query.conversation_id) {
        rows = rows.filter((l) => l.conversation_id === query.conversation_id);
        rows.sort((a, b) => a.created_at.localeCompare(b.created_at));
      } else {
        if (query.tool_name) rows = rows.filter((l) => l.tool_name === query.tool_name);
        rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
        rows = rows.slice(0, Number(query.limit ?? 100));
      }
      return ok(rows);
    }

    if (method === "GET" && p === "/api/v1/dashboard/quota") {
      if (query.store_id !== storeId) return deny();
      return ok(fx.quota);
    }

    return { status: 404, body: { success: false, error: "not found" } };
  };
}

// The fixture as a `fetch`: what KustomerApi calls when given `fetch` in its
// config. `record` sees every request, as the Node server's `requests` does.
export function fixtureFetch(fx: Fixture = fixture, opts: FakeApiOptions = {}, record?: (r: RecordedRequest) => void): typeof fetch {
  const handle = createFixtureHandler(fx, opts);
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    const query = Object.fromEntries(url.searchParams);
    record?.({ method, path: url.pathname, query });
    const out = await handle({
      method,
      path: url.pathname,
      query,
      authorization: new Headers(init?.headers).get("authorization") ?? undefined,
      body: typeof init?.body === "string" ? init.body : "",
    });
    return new Response(JSON.stringify(out.body), { status: out.status, headers: { "Content-Type": "application/json" } });
  };
}

export async function startFakeApi(fx: Fixture = fixture, opts: FakeApiOptions = {}): Promise<FakeApi> {
  const requests: RecordedRequest[] = [];
  const handle = createFixtureHandler(fx, opts);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const query = Object.fromEntries(url.searchParams);
    requests.push({ method: req.method ?? "", path: url.pathname, query });
    const out = await handle({
      method: req.method ?? "",
      path: url.pathname,
      query,
      authorization: req.headers.authorization,
      body: req.method === "POST" ? await readBody(req) : "",
    });
    send(res, out.status, out.body);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function activity(c: { last_message_at?: string; started_at: string }): string {
  return c.last_message_at ?? c.started_at;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
