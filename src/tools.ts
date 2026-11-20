import { ApiError, type KustomerApi } from "./api.js";
import { untrusted, type TextSource } from "./untrusted.js";

export interface ToolContext {
  api: KustomerApi;
  redact: (text: string) => string;
}

export type ToolHandler = (args: Record<string, any>, ctx: ToolContext) => Promise<Record<string, unknown>>;

// REST shapes, only the fields the tools read.
interface ConversationRow {
  id: string;
  channel?: string;
  status?: string; // production: OPEN | CLOSED | ARCHIVED. Older fixtures: read | unread.
  unread?: boolean; // production (AGEN-57): never opened, or a message arrived since; clients use this, not status
  handover_status?: string;
  started_at?: string;
  last_message_at?: string;
  message_count?: number;
  last_message_preview?: string;
}

interface MessageRow {
  id: string;
  role: string;
  content: string;
  created_at: string;
  sent_at?: string;
  source?: string;
  message_type?: string;
  response_source?: string;
  kb_sources?: unknown;
  confidence?: number | null;
  is_historical?: boolean;
}

interface KnowledgeRow {
  chunk_text: string;
  title: string;
  similarity: number;
  kb_item_id: string;
}

interface ToolLogRow {
  tool_name: string;
  created_at: string;
  called_at?: string | null;
  error_type?: string | null;
  response_status?: number | null;
  response_time_ms?: number | null;
  conversation_id?: string | null;
  ai_arguments?: string | null;
  error_message?: string | null;
  corrections?: unknown;
}

type QuotaRow = Record<string, number | string>;

// Drop undefined values: an output key that is present must match its schema.
function compact<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null)) as T;
}

function handoverStatus(s: string | undefined): string {
  return s === "pending" || s === "taken" || s === "closed" ? s : "none";
}

function author(m: MessageRow): "customer" | "bot" | "agent" | "system" {
  if (m.role === "user") return "customer";
  if (m.role === "agent" || m.source === "AGENT_INBOX") return "agent";
  if (m.role === "system") return "system";
  return "bot";
}

function knowledgeTitles(sources: unknown): string[] | undefined {
  if (!Array.isArray(sources)) return undefined;
  const titles = sources
    .map((s) => (s && typeof s === "object" ? (s as { title?: unknown }).title : undefined))
    .filter((t): t is string => typeof t === "string" && t !== "");
  return titles.length ? [...new Set(titles)] : undefined;
}

const listConversations: ToolHandler = async (args, { api, redact }) => {
  const data = await api.get<{ items: ConversationRow[] | null; total: number }>("/api/v1/conversations", {
    store_id: api.storeId,
    channel: args.channel,
    handover_status: args.handover_status,
    since: args.since,
    limit: args.limit,
    offset: args.offset,
  });
  const items = data.items ?? [];
  return {
    conversations: items.map((c) =>
      compact({
        id: c.id,
        channel: c.channel ?? "",
        handover_status: handoverStatus(c.handover_status),
        // The API says `unread` itself; `status === "unread"` is the older convention the fixtures still use.
        unread: c.unread ?? c.status === "unread",
        last_activity_at: c.last_message_at || c.started_at || "",
        message_count: c.message_count ?? 0,
        last_message_preview: c.last_message_preview ? untrusted("conversation", c.last_message_preview, redact) : undefined,
      }),
    ),
    total: data.total,
    has_more: args.offset + items.length < data.total,
  };
};

const getConversation: ToolHandler = async (args, { api, redact }) => {
  const data = await api.get<{ conversation: ConversationRow; messages: MessageRow[] | null }>(
    `/api/v1/conversations/${encodeURIComponent(args.conversation_id)}`,
    { mark_read: false },
  );
  const all = data.messages ?? [];
  // `before` is a message id of this conversation; an id that is not in it (including one from another store's
  // conversation, which this response never contains) is "not found", the same as an unknown conversation.
  const end = args.before === undefined ? all.length : all.findIndex((m) => m.id === args.before);
  if (end < 0) throw new ApiError(404, "message not found in this conversation");
  const older = all.slice(0, end);
  const kept = older.slice(-args.max_messages);
  return {
    id: data.conversation.id,
    channel: data.conversation.channel ?? "",
    handover_status: handoverStatus(data.conversation.handover_status),
    truncated: kept.length < older.length,
    ...(kept.length < older.length ? { next_before: kept[0]!.id } : {}),
    messages: kept.map((m) => {
      const who = author(m);
      const source: TextSource = who === "customer" ? "customer" : who === "agent" ? "agent" : "bot";
      return compact({
        id: m.id,
        author: who,
        sent_at: m.sent_at || m.created_at,
        message_type: m.message_type || undefined,
        content: untrusted(source, m.content ?? "", redact),
        response_source: m.response_source || undefined,
        knowledge_titles: knowledgeTitles(m.kb_sources),
        confidence: m.confidence ?? undefined,
        historical: m.is_historical || undefined,
      });
    }),
  };
};

const searchKnowledge: ToolHandler = async (args, { api, redact }) => {
  const rows = await api.post<KnowledgeRow[] | null>("/api/v1/knowledge-base/search", {
    store_id: api.storeId,
    query: args.query,
    limit: args.limit,
  });
  return {
    results: (rows ?? []).map((r) => ({
      document_id: r.kb_item_id,
      title: r.title,
      similarity: r.similarity,
      passage: untrusted("knowledge", r.chunk_text, redact),
    })),
  };
};

const getToolCalls: ToolHandler = async (args, { api, redact }) => {
  // With conversation_id the API returns every call of that conversation and
  // ignores tool_name and limit, so both are applied here as well.
  const rows = await api.get<ToolLogRow[] | null>(
    `/api/v1/stores/${encodeURIComponent(api.storeId)}/tool-execution-logs`,
    {
      conversation_id: args.conversation_id,
      tool_name: args.tool_name,
      limit: args.failed_only ? 100 : args.limit,
    },
  );
  const calls = (rows ?? [])
    .filter((r) => !args.tool_name || r.tool_name === args.tool_name)
    .filter((r) => !args.failed_only || (r.error_type ?? "success") !== "success")
    .slice(0, args.limit);
  return {
    calls: calls.map((r) =>
      compact({
        tool_name: r.tool_name,
        called_at: r.called_at || r.created_at,
        outcome: r.error_type || "unknown",
        http_status: r.response_status ?? undefined,
        duration_ms: r.response_time_ms ?? undefined,
        conversation_id: r.conversation_id ?? undefined,
        arguments: r.ai_arguments ? untrusted("tool", r.ai_arguments, redact) : undefined,
        error: r.error_message ? untrusted("tool", r.error_message, redact) : undefined,
        corrected_arguments: hasCorrections(r.corrections) || undefined,
      }),
    ),
  };
};

function hasCorrections(c: unknown): boolean {
  if (Array.isArray(c)) return c.length > 0;
  return c !== null && typeof c === "object" && Object.keys(c).length > 0;
}

const CHANNELS = ["whatsapp", "telegram", "instagram", "livechat", "api"] as const;

const getUsage: ToolHandler = async (_args, { api }) => {
  const q = await api.get<QuotaRow>("/api/v1/dashboard/quota", { store_id: api.storeId });
  const num = (k: string) => Number(q[k] ?? 0);
  return {
    period_start: String(q.period_start ?? ""),
    period_end: String(q.period_end ?? ""),
    channels: CHANNELS.map((ch) => ({
      channel: ch,
      conversations_used: num(`${ch}_conversations_used`),
      conversations_limit: num(`${ch}_conversations_limit`),
      messages_used: num(`${ch}_used`),
      messages_limit: num(`${ch}_limit`),
    })),
    ai_tokens: { used: num("ai_tokens_used"), billed: num("ai_tokens_billed"), limit: num("ai_tokens_limit") },
  };
};

export const handlers: Record<string, ToolHandler> = {
  list_conversations: listConversations,
  get_conversation: getConversation,
  search_knowledge: searchKnowledge,
  get_tool_calls: getToolCalls,
  get_usage: getUsage,
};
