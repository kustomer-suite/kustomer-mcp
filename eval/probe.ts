import type { ToolSet } from "./types.js";

// The facts a task needs, read the same way in both conditions. An agent (or the
// oracle) asks the probe; the probe talks to whichever tool set it was given.
export interface Msg {
  author: "customer" | "bot" | "agent";
  text: string;
  responseSource?: string;
  titles?: string[];
  confidence?: number;
}
export interface ConvRow {
  id: string;
  unread: boolean;
  channel: string;
  handover: string;
  lastActivity: string;
  preview: string;
}
export interface Probe {
  allConversations(): Promise<ConvRow[]>; // every page
  conversationAll(id: string): Promise<{ found: boolean; messages: Msg[] }>; // every message, not the default window
  failedToolCallsAll(): Promise<Array<{ tool: string; status: number }>>; // the whole store
  pending(): Promise<string[]>;
  unread(): Promise<string[]>;
  conversation(id: string): Promise<{ found: boolean; messages: Msg[] }>;
  failedToolCalls(conversationId: string): Promise<Array<{ tool: string; outcome: string; status: number }>>;
  usage(): Promise<{ whatsappUsed: number; whatsappLimit: number; billed: number }>;
  search(query: string): Promise<string[]>;
}

const parse = (text: string) => JSON.parse(text.replace(/^HTTP \d+\n/, ""));
const failed = (text: string) => text.startsWith("ERROR:") || /^HTTP (4|5)\d\d/.test(text);

export function mcpProbe(ts: ToolSet): Probe {
  const j = async (name: string, args: Record<string, unknown>) => ts.call(name, args);
  const readThread = async (id: string, max: number) => {
    const text = await j("get_conversation", { conversation_id: id, max_messages: max });
    if (failed(text)) return { found: false, messages: [] as Msg[] };
    const r = parse(text);
    return {
      found: true,
      messages: r.messages.map((m: any) => ({
        author: m.author, text: m.content.text, responseSource: m.response_source, titles: m.knowledge_titles, confidence: m.confidence,
      })) as Msg[],
    };
  };
  return {
    async allConversations() {
      const rows: ConvRow[] = [];
      for (let offset = 0; ; offset += 50) {
        const r = parse(await j("list_conversations", { limit: 50, offset }));
        for (const c of r.conversations)
          rows.push({ id: c.id, unread: c.unread, channel: c.channel, handover: c.handover_status, lastActivity: c.last_activity_at, preview: c.last_message_preview?.text ?? "" });
        if (!r.has_more) return rows;
      }
    },
    conversationAll: (id) => readThread(id, 200),
    async failedToolCallsAll() {
      const r = parse(await j("get_tool_calls", { failed_only: true, limit: 100 }));
      return r.calls.map((c: any) => ({ tool: c.tool_name, status: c.http_status }));
    },
    async pending() {
      return parse(await j("list_conversations", { handover_status: "pending", limit: 50 })).conversations.map((c: { id: string }) => c.id);
    },
    async unread() {
      const r = parse(await j("list_conversations", { limit: 50 }));
      return r.conversations.filter((c: { unread: boolean }) => c.unread).map((c: { id: string }) => c.id);
    },
    async conversation(id) {
      const text = await j("get_conversation", { conversation_id: id });
      if (failed(text)) return { found: false, messages: [] };
      const r = parse(text);
      return {
        found: true,
        messages: r.messages.map((m: any) => ({
          author: m.author, text: m.content.text, responseSource: m.response_source, titles: m.knowledge_titles, confidence: m.confidence,
        })),
      };
    },
    async failedToolCalls(conversationId) {
      const r = parse(await j("get_tool_calls", { conversation_id: conversationId, failed_only: true }));
      return r.calls.map((c: any) => ({ tool: c.tool_name, outcome: c.outcome, status: c.http_status }));
    },
    async usage() {
      const r = parse(await j("get_usage", {}));
      const wa = r.channels.find((c: any) => c.channel === "whatsapp");
      return { whatsappUsed: wa.conversations_used, whatsappLimit: wa.conversations_limit, billed: r.ai_tokens.billed };
    },
    async search(query) {
      return parse(await j("search_knowledge", { query })).results.map((x: any) => x.passage.text);
    },
  };
}

export function restProbe(ts: ToolSet, storeId: string): Probe {
  const get = async (path: string, query: Record<string, string> = {}) => ts.call("http_request", { method: "GET", path, query });
  return {
    async allConversations() {
      const rows: ConvRow[] = [];
      for (let offset = 0; ; offset += 50) {
        const r = parse(await get("/api/v1/conversations", { store_id: storeId, limit: "50", offset: String(offset) })).data;
        for (const c of r.items)
          rows.push({ id: c.id, unread: c.status === "unread", channel: c.channel, handover: c.handover_status, lastActivity: c.last_message_at ?? c.started_at, preview: c.last_message_preview ?? "" });
        if (offset + r.items.length >= r.total || r.items.length === 0) return rows;
      }
    },
    conversationAll: (id) => restProbeConversation(get, id),
    async failedToolCallsAll() {
      const rows = parse(await get(`/api/v1/stores/${storeId}/tool-execution-logs`, { limit: "100" })).data;
      return rows.filter((r: any) => (r.error_type ?? "success") !== "success").map((r: any) => ({ tool: r.tool_name, status: r.response_status }));
    },
    async pending() {
      return parse(await get("/api/v1/conversations", { store_id: storeId, handover_status: "pending", limit: "50" })).data.items.map((c: any) => c.id);
    },
    async unread() {
      const r = parse(await get("/api/v1/conversations", { store_id: storeId, limit: "50" }));
      return r.data.items.filter((c: any) => c.status === "unread").map((c: any) => c.id);
    },
    async conversation(id) {
      const text = await get(`/api/v1/conversations/${id}`);
      if (failed(text)) return { found: false, messages: [] };
      const r = parse(text).data;
      return {
        found: true,
        messages: r.messages.map((m: any) => ({
          author: m.role === "user" ? "customer" : m.source === "AGENT_INBOX" ? "agent" : "bot",
          text: m.content, responseSource: m.response_source,
          titles: Array.isArray(m.kb_sources) ? m.kb_sources.map((s: any) => s.title) : undefined, confidence: m.confidence,
        })),
      };
    },
    async failedToolCalls(conversationId) {
      const rows = parse(await get(`/api/v1/stores/${storeId}/tool-execution-logs`, { conversation_id: conversationId })).data;
      return rows.filter((r: any) => (r.error_type ?? "success") !== "success").map((r: any) => ({ tool: r.tool_name, outcome: r.error_type, status: r.response_status }));
    },
    async usage() {
      const q = parse(await get("/api/v1/dashboard/quota", { store_id: storeId })).data;
      return { whatsappUsed: q.whatsapp_conversations_used, whatsappLimit: q.whatsapp_conversations_limit, billed: q.ai_tokens_billed };
    },
    async search(query) {
      const text = await ts.call("http_request", { method: "POST", path: "/api/v1/knowledge-base/search", body: { store_id: storeId, query, limit: 5 } });
      return parse(text).data.map((r: any) => r.chunk_text);
    },
  };
}

// Shared by the REST probe's two ways of reading a thread. The REST endpoint
// returns every message, so "all" and "default" are the same call there.
async function restProbeConversation(get: (path: string, q?: Record<string, string>) => Promise<string>, id: string) {
  const text = await get(`/api/v1/conversations/${id}`);
  if (failed(text)) return { found: false, messages: [] as Msg[] };
  const r = parse(text).data;
  return {
    found: true,
    messages: r.messages.map((m: any) => ({
      author: m.role === "user" ? "customer" : m.source === "AGENT_INBOX" ? "agent" : "bot",
      text: m.content, responseSource: m.response_source,
      titles: Array.isArray(m.kb_sources) ? m.kb_sources.map((s: any) => s.title) : undefined, confidence: m.confidence,
    })) as Msg[],
  };
}
