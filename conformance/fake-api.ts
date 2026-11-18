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
export async function startFakeApi(fx: Fixture = fixture): Promise<FakeApi> {
  const requests: RecordedRequest[] = [];
  const storeId = fx.store.id;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const query = Object.fromEntries(url.searchParams);
    requests.push({ method: req.method ?? "", path: url.pathname, query });

    if (req.headers.authorization !== `Bearer ${fx.token}`) return send(res, 401, { success: false, error: "unauthorized" });

    const deny = () => send(res, 403, { success: false, error: "forbidden" });
    const ok = (data: unknown) => send(res, 200, { success: true, data });
    const p = url.pathname;

    if (req.method === "GET" && p === "/api/v1/conversations") {
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
    if (req.method === "GET" && conv) {
      const c = fx.conversations.find((x) => x.id === decodeURIComponent(conv[1]!));
      if (!c || c.store_id !== storeId) return send(res, 404, { success: false, error: "Conversation not found" });
      const { messages, ...rest } = c;
      return ok({ conversation: rest, messages: messages.map((m) => ({ ...m, conversation_id: c.id })) });
    }

    if (req.method === "POST" && p === "/api/v1/knowledge-base/search") {
      const body = JSON.parse((await readBody(req)) || "{}") as { store_id?: string; query?: string; limit?: number };
      if (body.store_id !== storeId) return deny();
      const words = (body.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const scored = fx.knowledge
        .filter((k) => k.store_id === storeId)
        .map((k) => {
          const text = `${k.title} ${k.chunk_text}`.toLowerCase();
          const hits = words.filter((w) => text.includes(w)).length;
          return { chunk_text: k.chunk_text, title: k.title, kb_item_id: k.kb_item_id, similarity: words.length ? hits / words.length : 0 };
        })
        .filter((r) => r.similarity > 0)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, body.limit ?? 5);
      return ok(scored);
    }

    const logs = p.match(/^\/api\/v1\/stores\/([^/]+)\/tool-execution-logs$/);
    if (req.method === "GET" && logs) {
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

    if (req.method === "GET" && p === "/api/v1/dashboard/quota") {
      if (query.store_id !== storeId) return deny();
      return ok(fx.quota);
    }

    return send(res, 404, { success: false, error: "not found" });
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
