import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { fixture as basic, type Fixture } from "../conformance/fake-api.js";
import { checks, loadConformanceSpec, type CheckContext } from "../conformance/suite.js";
import { createDbHandler, sinceCutoff } from "../edge/db-handler.js";
import { handleMcp } from "../edge/handler.js";
import { buildHardFixture, HARD } from "../eval/fixture-hard.js";
import { dataSql, embeddingsSql } from "../scripts/sandbox-seed.js";

// Needs a Postgres with the pgvector extension, e.g.
//   docker run -d --rm -p 55432:5432 -e POSTGRES_PASSWORD=pw pgvector/pgvector:pg15
//   SANDBOX_TEST_DB_URL=postgres://postgres:pw@127.0.0.1:55432/postgres npm test
// Without SANDBOX_TEST_DB_URL these tests are skipped (and say so); CI sets it.
const URL_ = process.env.SANDBOX_TEST_DB_URL;
const d = URL_ ? describe : describe.skip;

// A stand-in for the embedding API: a bag of hashed words in 1536 dimensions. Texts that share words
// are close, which is all the tests need; no network, no key.
function wordVector(text: string): number[] {
  const v = new Array<number>(1536).fill(0);
  for (const w of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    let h = 2166136261;
    for (const c of w) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
    v[h % 1536]! += 1;
  }
  const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  return v.map((x) => x / n);
}
const embed = async (t: string) => wordVector(t);
const MODEL = "test-model";
const TOKEN = "demo-token-for-db-tests";
const schema = readFileSync("supabase/migrations/20261119120000_sandbox_schema.sql", "utf8");
const url = "https://edge.test/functions/v1/kustomer-mcp";

d("the Edge Function on a database", () => {
  const sql = postgres(URL_ ?? "postgres://invalid", { max: 1, onnotice: () => {}, connection: { search_path: "public,extensions" } });
  afterAll(async () => {
    await sql.end();
  });

  async function load(fx: Fixture, model = MODEL) {
    await sql.unsafe("drop schema if exists sandbox cascade");
    await sql.unsafe("create schema if not exists extensions; create extension if not exists vector with schema extensions");
    await sql.unsafe(schema);
    await sql.unsafe(dataSql(fx));
    await sql.unsafe(await embeddingsSql(fx, embed, model));
  }
  const backendFor = (fx: Fixture, over: Partial<Parameters<typeof createDbHandler>[0]> = {}) => ({
    token: "internal",
    storeId: fx.store.id,
    handler: createDbHandler({ sql, storeId: fx.store.id, token: "internal", embed, embeddingModel: MODEL, ...over }),
  });
  async function connect(fx: Fixture, over: Partial<Parameters<typeof createDbHandler>[0]> = {}) {
    const backend = backendFor(fx, over);
    const f: typeof fetch = (input, init) => handleMcp(new Request(input as string | URL, init), { token: TOKEN, backend });
    const client = new Client({ name: "db-test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { fetch: f, requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
    return client;
  }

  describe("the conformance fixture", () => {
    let client: Client;
    beforeAll(async () => {
      await load(basic);
      client = await connect(basic);
    });
    afterAll(() => client?.close());

    // The suite the TypeScript server, the Go server and the npm proxy all pass.
    it("passes the conformance checks that do not read a fake REST API's request log", async () => {
      const ctx: CheckContext = { client, spec: loadConformanceSpec(), fixture: basic };
      const runnable = checks.filter((c) => !c.fakeBackend);
      expect(runnable.length).toBeGreaterThanOrEqual(12);
      for (const c of runnable) await c.run(ctx);
    });
  });

  describe("the harder store", () => {
    const hard = buildHardFixture();
    let client: Client;
    beforeAll(async () => {
      await load(hard);
      client = await connect(hard);
    });
    afterAll(() => client?.close());
    const run = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })).structuredContent as Record<string, any>;

    it("pages: more than one page, in order, with has_more, and the last page ends", async () => {
      const first = await run("list_conversations", { limit: 50 });
      expect(first.total).toBe(56);
      expect(first.has_more).toBe(true);
      const second = await run("list_conversations", { limit: 50, offset: 50 });
      expect(second.conversations).toHaveLength(6);
      expect(second.has_more).toBe(false);
      const ids = [...first.conversations, ...second.conversations].map((c: { id: string }) => c.id);
      expect(new Set(ids).size).toBe(56);
    });

    it("filters by channel and handover status the way the fixture's REST does", async () => {
      const own = hard.conversations.filter((c) => c.store_id === hard.store.id);
      const pending = await run("list_conversations", { handover_status: "pending", limit: 50 });
      expect(pending.total).toBe(own.filter((c) => c.handover_status === "pending").length);
      const wa = await run("list_conversations", { channel: "whatsapp", handover_status: "pending", limit: 50 });
      expect(wa.total).toBe(own.filter((c) => c.channel === "whatsapp" && c.handover_status === "pending").length);
    });

    it("cuts the long thread to its last 50 messages and says so; max_messages brings the first one back", async () => {
      const cut = await run("get_conversation", { conversation_id: HARD.longThread });
      expect(cut.truncated).toBe(true);
      expect(JSON.stringify(cut)).not.toContain("Super Cottage");
      const full = await run("get_conversation", { conversation_id: HARD.longThread, max_messages: 200 });
      expect(JSON.stringify(full)).toContain("Super Cottage");
    });

    it("wraps a planted instruction as customer text", async () => {
      const r = await run("get_conversation", { conversation_id: HARD.injPlain });
      const planted = r.messages.find((m: { content: { text: string } }) => m.content.text.includes(HARD.canary.plain));
      expect(planted.author).toBe("customer");
      expect(planted.content.untrusted).toBe(true);
    });

    it("keeps what the store's tools keep secret out of the answers", async () => {
      expect(JSON.stringify(await run("get_tool_calls", { limit: 100 }))).not.toContain("s3cret-PW-9921");
    });

    it("searches by vector: the passage a query repeats comes first with similarity near 1", async () => {
      const k = hard.knowledge.find((x) => x.kb_item_id === "kb-h-1")!;
      const r = await run("search_knowledge", { query: `${k.title}\n${k.chunk_text}`, limit: 3 });
      expect(r.results).toHaveLength(3);
      expect(r.results[0].passage.text).toContain("Garden Restaurant");
      expect(r.results[0].similarity).toBeGreaterThan(0.99);
      expect(r.results[0].similarity).toBeGreaterThan(r.results[1].similarity);
    });

    it("answers a question the knowledge base does not cover with its nearest passages, like production (it cannot say 'not covered')", async () => {
      const r = await run("search_knowledge", { query: "zzzz qqqq pets", limit: 5 });
      expect(r.results.length).toBeGreaterThan(0);
    });
  });

  describe("what only a database can get wrong", () => {
    const hard = buildHardFixture();
    beforeAll(() => load(hard));

    it("refuses to search when the stored vectors came from another embedding model", async () => {
      const client = await connect(hard, { embeddingModel: "some-other-model" });
      const r = await client.callTool({ name: "search_knowledge", arguments: { query: "breakfast" } });
      expect(r.isError).toBe(true);
      await client.close();
    });

    it("limits searches per minute across calls, and says so", async () => {
      await sql`delete from sandbox.search_log`;
      const client = await connect(hard, { searchesPerMinute: 2 });
      const results = [];
      for (let i = 0; i < 3; i++) results.push((await client.callTool({ name: "search_knowledge", arguments: { query: `breakfast ${i}` } })).isError === true);
      expect(results).toEqual([false, false, true]);
      await client.close();
      await sql`delete from sandbox.search_log`;
    });

    it("answers 404 for a conversation of another store or a malformed id, and never lists another store", async () => {
      const client = await connect(hard);
      const other = hard.conversations.find((c) => c.store_id !== hard.store.id)!;
      expect((await client.callTool({ name: "get_conversation", arguments: { conversation_id: other.id } })).isError).toBe(true);
      const all = (await client.callTool({ name: "list_conversations", arguments: { limit: 50 } })).structuredContent as { conversations: Array<{ id: string }> };
      expect(all.conversations.map((c) => c.id)).not.toContain(other.id);
      await client.close();
    });

    it("does not put a database error into the answer", async () => {
      const h = createDbHandler({ sql: postgres("postgres://nobody:secret-pw@127.0.0.1:1/none", { max: 1, connect_timeout: 1 }), storeId: hard.store.id, token: "internal", embed, embeddingModel: MODEL });
      const out = await h({ method: "GET", path: "/api/v1/dashboard/quota", query: { store_id: hard.store.id }, authorization: "Bearer internal", body: "" });
      expect(out.status).toBe(500);
      expect(JSON.stringify(out.body)).not.toMatch(/secret-pw|127\.0\.0\.1|nobody/);
    });
  });
});

describe("sinceCutoff (no database needed)", () => {
  const now = new Date("2026-11-19T15:30:00Z");
  it("uses the production windows and nothing else", () => {
    expect(sinceCutoff("today", now)?.toISOString()).toBe("2026-11-19T00:00:00.000Z");
    expect(sinceCutoff("7days", now)?.toISOString()).toBe("2026-11-12T15:30:00.000Z");
    expect(sinceCutoff("90days", now)?.toISOString()).toBe("2026-08-21T15:30:00.000Z");
    expect(sinceCutoff("yesterday", now)).toBeUndefined();
    expect(sinceCutoff(undefined, now)).toBeUndefined();
  });
});
