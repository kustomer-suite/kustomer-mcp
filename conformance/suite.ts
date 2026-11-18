import { Ajv } from "ajv";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

import { loadSpec, type Spec } from "../src/spec.js";
import type { Fixture, RecordedRequest } from "./fake-api.js";

// Transport-agnostic checks every Kustomer Suite MCP server must pass, given
// a store seeded with conformance/fixture.json. Checks marked fakeBackend
// read the requests the server sent, so only a server running against the
// fake REST API can be held to them; the Go server proves the same property
// against its database instead.

export interface CheckContext {
  client: Client;
  spec: Spec;
  fixture: Fixture;
  requests?: RecordedRequest[];
}

export interface Check {
  id: string;
  description: string;
  fakeBackend?: boolean;
  run(ctx: CheckContext): Promise<void>;
}

export class CheckFailure extends Error {}

function expect(cond: unknown, message: string): asserts cond {
  if (!cond) throw new CheckFailure(message);
}

// JSON with sorted keys: clients and SDKs may reorder object keys.
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const entries = Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

interface CallResult {
  isError: boolean;
  text: string;
  structured: Record<string, unknown> | undefined;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<CallResult> {
  const r = await client.callTool({ name, arguments: args });
  const content = (r.content ?? []) as Array<{ type: string; text?: string }>;
  return {
    isError: r.isError === true,
    text: content.map((c) => c.text ?? "").join("\n"),
    structured: r.structuredContent as Record<string, unknown> | undefined,
  };
}

async function ok(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const r = await call(client, name, args);
  expect(!r.isError, `${name}(${JSON.stringify(args)}) failed: ${r.text}`);
  expect(r.structured, `${name} returned no structuredContent`);
  return r.structured;
}

const ownConversations = (fx: Fixture) => fx.conversations.filter((c) => c.store_id === fx.store.id);

// One call of every tool, covering every fixture record of the store.
async function everyOutput(ctx: CheckContext): Promise<Array<{ call: string; output: unknown; text: string }>> {
  const { client, fixture } = ctx;
  const calls: Array<[string, Record<string, unknown>]> = [
    ["list_conversations", { limit: 50 }],
    ...ownConversations(fixture).map((c): [string, Record<string, unknown>] => ["get_conversation", { conversation_id: c.id }]),
    ["search_knowledge", { query: "harga kamar check-in", limit: 20 }],
    ["get_tool_calls", { limit: 100 }],
    ["get_tool_calls", { conversation_id: fixture.conversations[0]!.id }],
    ["get_usage", {}],
  ];
  const out = [];
  for (const [name, args] of calls) {
    const r = await call(client, name, args);
    out.push({ call: `${name}(${JSON.stringify(args)})`, output: r.structured ?? null, text: r.text });
  }
  return out;
}

// Every string that contains `needle`, with the object holding it.
function findStrings(node: unknown, needle: string, parent: unknown = null, key = ""): Array<{ parent: unknown; key: string }> {
  if (typeof node === "string") return node.includes(needle) ? [{ parent, key }] : [];
  if (Array.isArray(node)) return node.flatMap((n) => findStrings(n, needle, node, ""));
  if (node && typeof node === "object") {
    return Object.entries(node).flatMap(([k, v]) => findStrings(v, needle, node, k));
  }
  return [];
}

export const checks: Check[] = [
  {
    id: "tools-match-spec",
    description: "tools/list exposes exactly the spec's tools, with the spec's schemas and annotations",
    async run({ client, spec }) {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      const want = spec.tools.map((t) => t.name).sort();
      expect(JSON.stringify(names) === JSON.stringify(want), `tools ${names.join(",")} != spec ${want.join(",")}`);
      for (const t of spec.tools) {
        const got = tools.find((x) => x.name === t.name)!;
        expect(got.description === t.description, `${t.name}: description differs from the spec`);
        expect(canonical(got.inputSchema) === canonical(t.inputSchema), `${t.name}: inputSchema differs from the spec`);
        expect(canonical(got.outputSchema) === canonical(t.outputSchema), `${t.name}: outputSchema differs from the spec`);
        for (const [k, v] of Object.entries(t.annotations)) {
          expect((got.annotations as Record<string, unknown> | undefined)?.[k] === v, `${t.name}: annotation ${k} should be ${v}`);
        }
      }
    },
  },
  {
    id: "outputs-match-schema",
    description: "every result validates against its tool's outputSchema",
    async run(ctx) {
      const ajv = new Ajv({ allErrors: true, strict: false });
      for (const o of await everyOutput(ctx)) {
        const name = o.call.slice(0, o.call.indexOf("("));
        const tool = ctx.spec.tools.find((t) => t.name === name)!;
        expect(o.output, `${o.call} returned no structured output: ${o.text}`);
        const valid = ajv.validate(tool.outputSchema, o.output);
        expect(valid, `${o.call}: ${ajv.errorsText(ajv.errors)}`);
      }
    },
  },
  {
    id: "text-mirrors-structured",
    description: "the text content of a result carries the same data as structuredContent",
    async run(ctx) {
      for (const o of await everyOutput(ctx)) {
        expect(canonical(JSON.parse(o.text)) === canonical(o.output), `${o.call}: text and structuredContent differ`);
      }
    },
  },
  {
    id: "list-own-store-only",
    description: "list_conversations returns the store's conversations, none of another store, and filters by handover status",
    async run({ client, fixture }) {
      const all = await ok(client, "list_conversations", { limit: 50 });
      const ids = (all.conversations as Array<{ id: string }>).map((c) => c.id).sort();
      const want = ownConversations(fixture).map((c) => c.id).sort();
      expect(JSON.stringify(ids) === JSON.stringify(want), `got ${ids.join(",")}, want ${want.join(",")}`);
      expect(all.total === want.length && all.has_more === false, `total/has_more wrong: ${all.total}/${all.has_more}`);

      const pending = await ok(client, "list_conversations", { handover_status: "pending" });
      const p = pending.conversations as Array<{ id: string; handover_status: string; unread: boolean }>;
      const wantPending = ownConversations(fixture).filter((c) => c.handover_status === "pending");
      expect(p.length === wantPending.length && p.every((c) => c.handover_status === "pending"), "handover_status=pending filter");
      expect(p[0]?.unread === true, "an unread conversation is reported unread");

      const page = await ok(client, "list_conversations", { limit: 1 });
      expect((page.conversations as unknown[]).length === 1 && page.has_more === true, "limit=1 gives one item and has_more");
    },
  },
  {
    id: "conversation-authors",
    description: "get_conversation tells customer, bot and agent apart and keeps the bot's evidence",
    async run({ client, fixture }) {
      const [c1, c2, c3] = ownConversations(fixture);
      const one = await ok(client, "get_conversation", { conversation_id: c1!.id });
      expect(one.handover_status === "pending", "c1 is pending");
      const authors1 = (one.messages as Array<{ author: string }>).map((m) => m.author);
      expect(JSON.stringify(authors1) === JSON.stringify(["customer", "bot", "customer", "customer"]), `c1 authors ${authors1}`);
      const failed = (one.messages as Array<{ response_source?: string }>)[1]!;
      expect(failed.response_source === "tool_error", "a reply after a failed tool keeps response_source=tool_error");

      const two = await ok(client, "get_conversation", { conversation_id: c2!.id });
      expect(two.handover_status === "none", "an empty handover status is reported as none");
      const [, bot, agent] = two.messages as Array<{ author: string; knowledge_titles?: string[]; confidence?: number }>;
      expect(bot!.author === "bot" && bot!.confidence === 88.1, "bot reply keeps its confidence");
      expect(JSON.stringify(bot!.knowledge_titles) === JSON.stringify(["Harga Kamar"]), "knowledge titles are listed once each");
      expect(agent!.author === "agent", "an inbox reply is written by an agent");

      const three = await ok(client, "get_conversation", { conversation_id: c3!.id });
      const m = (three.messages as Array<{ historical?: boolean; sent_at: string }>)[0]!;
      expect(m.historical === true && m.sent_at === "2026-10-01T09:00:00Z", "historical messages keep their original time");

      // Message ids are whatever the server's store assigns (UUIDs in a database,
      // the fixture's own ids in a fake API), so compare against the full thread.
      const fullIds = (one.messages as Array<{ id: string }>).map((x) => x.id);
      const short = await ok(client, "get_conversation", { conversation_id: c1!.id, max_messages: 2 });
      const kept = (short.messages as Array<{ id: string }>).map((x) => x.id);
      expect(fullIds.length === 4, `c1 has 4 messages, got ${fullIds.length}`);
      expect(short.truncated === true && JSON.stringify(kept) === JSON.stringify(fullIds.slice(-2)), `max_messages keeps the latest: ${kept}`);
    },
  },
  {
    id: "untrusted-text-wrapped",
    description: "customer-written text only ever appears inside an UntrustedText object",
    async run(ctx) {
      const marker = ctx.fixture.markers.injection;
      let seen = 0;
      for (const o of await everyOutput(ctx)) {
        for (const hit of findStrings(o.output, marker)) {
          seen++;
          const p = hit.parent as Record<string, unknown> | null;
          expect(hit.key === "text" && p?.untrusted === true && p?.source === "customer", `${o.call}: injected text outside an UntrustedText`);
        }
      }
      expect(seen > 0, "control: the injected message must be visible (wrapped) somewhere");
    },
  },
  {
    id: "pii-redacted",
    description: "phone numbers and email addresses are redacted, prices are not",
    async run(ctx) {
      const { phone, email, price } = ctx.fixture.markers;
      const outputs = await everyOutput(ctx);
      const all = JSON.stringify(outputs.map((o) => [o.output, o.text]));
      expect(!all.includes(phone) && !all.includes("6281234567890"), "a phone number leaked");
      expect(!all.includes(email) && !all.includes("reservasi@example.com"), "an email address leaked");
      expect(all.includes("[phone]") && all.includes("[email]"), "control: redaction placeholders must appear");
      expect(all.includes(price), "a price must not be redacted");
    },
  },
  {
    id: "other-store-invisible",
    description: "nothing of another store is reachable, by listing, by id, by search or in tool calls",
    async run(ctx) {
      const other = ctx.fixture.conversations.find((c) => c.store_id === ctx.fixture.otherStore.id)!;
      const r = await call(ctx.client, "get_conversation", { conversation_id: other.id });
      expect(r.isError, "another store's conversation must not be readable");
      const marker = ctx.fixture.markers.otherStore;
      const all = JSON.stringify((await everyOutput(ctx)).map((o) => [o.output, o.text])) + r.text;
      expect(!all.includes(marker), "another store's data leaked");
    },
  },
  {
    id: "secrets-never-returned",
    description: "request/response bodies, headers and endpoint URLs of store tools are never returned",
    async run(ctx) {
      const all = JSON.stringify((await everyOutput(ctx)).map((o) => [o.output, o.text]));
      expect(!all.includes(ctx.fixture.markers.password), "a store tool credential leaked");
      expect(!all.includes("hotel.example"), "a store tool endpoint URL leaked");
    },
  },
  {
    id: "tool-calls-filters",
    description: "get_tool_calls filters by conversation, tool and failure, and flags corrected arguments",
    async run({ client, fixture }) {
      const c1 = ownConversations(fixture)[0]!.id;
      const byConv = await ok(client, "get_tool_calls", { conversation_id: c1 });
      const calls = byConv.calls as Array<{ tool_name: string; outcome: string; corrected_arguments?: boolean; conversation_id?: string }>;
      expect(calls.length === 2 && calls.every((c) => c.conversation_id === c1), `conversation filter: ${calls.length} calls`);
      const failed = await ok(client, "get_tool_calls", { conversation_id: c1, failed_only: true, tool_name: "get_room_types" });
      const f = failed.calls as typeof calls;
      expect(f.length === 1 && f[0]!.outcome === "http_error" && f[0]!.corrected_arguments === true, "failed_only + tool_name + corrections");
      // The REST API ignores tool_name when conversation_id is given, so the
      // server has to apply it: the conversation holds a login and a room call.
      const login = await ok(client, "get_tool_calls", { conversation_id: c1, tool_name: "login" });
      const l = login.calls as typeof calls;
      expect(l.length === 1 && l[0]!.tool_name === "login", `tool_name must narrow a conversation's calls, got ${l.map((c) => c.tool_name)}`);
    },
  },
  {
    id: "usage-totals",
    description: "get_usage reports every channel and the AI tokens of the period",
    async run({ client, fixture }) {
      const u = await ok(client, "get_usage");
      const wa = (u.channels as Array<Record<string, unknown>>).find((c) => c.channel === "whatsapp")!;
      expect(wa.conversations_used === fixture.quota.whatsapp_conversations_used && wa.messages_limit === fixture.quota.whatsapp_limit, "whatsapp usage");
      expect((u.ai_tokens as Record<string, unknown>).billed === fixture.quota.ai_tokens_billed, "ai tokens billed");
    },
  },
  {
    id: "invalid-arguments-rejected",
    description: "arguments outside the input schema are rejected as a tool error, not passed to the API",
    async run({ client }) {
      const cases: Array<[string, Record<string, unknown>]> = [
        ["get_conversation", { conversation_id: "../../stores/x" }],
        ["get_conversation", {}],
        ["list_conversations", { limit: 999 }],
        ["list_conversations", { store_id: "22222222-2222-4222-8222-222222222222" }],
        ["search_knowledge", { query: "" }],
      ];
      for (const [name, args] of cases) {
        const r = await call(client, name, args);
        expect(r.isError, `${name}(${JSON.stringify(args)}) must be rejected`);
      }
    },
  },
  {
    id: "read-tools-have-no-side-effects",
    description: "read tools only send reads, and reading a conversation asks the API not to mark it read",
    fakeBackend: true,
    async run(ctx) {
      ctx.requests!.length = 0;
      await everyOutput(ctx);
      const sent = ctx.requests!;
      expect(sent.length > 0, "control: requests must be recorded");
      const writes = sent.filter((r) => !(r.method === "GET" || (r.method === "POST" && r.path === "/api/v1/knowledge-base/search")));
      expect(writes.length === 0, `write requests sent: ${writes.map((w) => `${w.method} ${w.path}`).join(", ")}`);
      const reads = sent.filter((r) => /^\/api\/v1\/conversations\/[^/]+$/.test(r.path));
      expect(reads.length > 0 && reads.every((r) => r.query.mark_read === "false"), "get_conversation must send mark_read=false");
    },
  },
];

export function loadConformanceSpec(): Spec {
  return loadSpec();
}
