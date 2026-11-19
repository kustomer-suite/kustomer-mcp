import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { fixture } from "../conformance/fake-api.js";
import { checks, loadConformanceSpec, type CheckContext } from "../conformance/suite.js";
import { handleMcp, type EdgeOptions } from "../edge/handler.js";
import { HARD } from "../eval/fixture-hard.js";

const TOKEN = "demo-token-for-tests-0123456789";
const url = "https://edge.test/functions/v1/kustomer-mcp";
const asFetch = (opts: EdgeOptions): typeof fetch => (input, init) => handleMcp(new Request(input as string | URL, init), opts);

const post = (opts: EdgeOptions, headers: Record<string, string> = {}, path = "") =>
  handleMcp(
    new Request(url + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
    opts,
  );

async function connect(opts: EdgeOptions): Promise<Client> {
  const client = new Client({ name: "edge-test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), { fetch: asFetch(opts), requestInit: { headers: { Authorization: `Bearer ${opts.token}` } } }),
  );
  return client;
}

describe("the Edge Function handler: who gets in", () => {
  it("is closed when it was deployed without its secret", async () => {
    expect((await post({}, { Authorization: "Bearer anything" })).status).toBe(503);
    expect((await post({ token: "" }, { Authorization: "Bearer " })).status).toBe(503);
  });

  it("refuses a missing, a wrong and a nearly right token; accepts the right one in the header or in the URL", async () => {
    const o = { token: TOKEN };
    expect((await post(o)).status).toBe(401);
    expect((await post(o, { Authorization: "Bearer nope" })).status).toBe(401);
    expect((await post(o, { Authorization: `Bearer ${TOKEN}x` })).status).toBe(401);
    expect((await post(o, { Authorization: `Bearer ${TOKEN}` })).status).toBe(200);
    expect((await post(o, {}, `?token=${TOKEN}`)).status).toBe(200);
    // The stray space that broke the first claude.ai connector (the nginx in front of the hosted
    // server does not decode it, so it answers 401 there). Here it is trimmed: what is accepted is
    // still exactly the secret, so being forgiving costs nothing.
    expect((await post(o, {}, `?token=%20${TOKEN}`)).status).toBe(200);
    expect((await post(o, {}, `?token=%20${TOKEN}x`)).status).toBe(401);
  });

  it("answers POST only, and says so", async () => {
    const r = await handleMcp(new Request(url, { method: "GET", headers: { Authorization: `Bearer ${TOKEN}` } }), { token: TOKEN });
    expect(r.status).toBe(405);
    expect(r.headers.get("allow")).toBe("POST");
  });
});

describe("the Edge Function handler: the same contract", () => {
  let client: Client;
  beforeAll(async () => {
    client = await connect({ token: TOKEN, fixture: "basic" });
  });
  afterAll(async () => {
    await client?.close();
  });

  it("lists the five tools of the contract", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["get_conversation", "get_tool_calls", "get_usage", "list_conversations", "search_knowledge"]);
  });

  // The suite the TypeScript server, the Go server and the npm proxy all pass.
  it("passes the conformance checks that do not read a fake REST API's request log", async () => {
    const ctx: CheckContext = { client, spec: loadConformanceSpec(), fixture };
    const runnable = checks.filter((c) => !c.fakeBackend);
    expect(runnable.length).toBeGreaterThanOrEqual(12);
    for (const c of runnable) await c.run(ctx);
  });
});

describe("the Edge Function handler: the harder demo store", () => {
  let client: Client;
  beforeAll(async () => {
    client = await connect({ token: TOKEN });
  });
  afterAll(async () => {
    await client?.close();
  });

  it("serves a store bigger than one page, and says the long thread was cut", async () => {
    const list = (await client.callTool({ name: "list_conversations", arguments: { limit: 50 } })).structuredContent as { total: number; has_more: boolean };
    expect(list.total).toBeGreaterThan(50);
    expect(list.has_more).toBe(true);
    const t = (await client.callTool({ name: "get_conversation", arguments: { conversation_id: HARD.longThread } })).structuredContent as { truncated: boolean };
    expect(t.truncated).toBe(true);
  });

  it("carries the planted instructions as wrapped customer text, never as the server's own words", async () => {
    const r = (await client.callTool({ name: "get_conversation", arguments: { conversation_id: HARD.injPlain } })).structuredContent as {
      messages: Array<{ author: string; content: { untrusted: boolean; source: string; text: string } }>;
    };
    const planted = r.messages.find((m) => m.content.text.includes(HARD.canary.plain))!;
    expect(planted.author).toBe("customer");
    expect(planted.content).toMatchObject({ untrusted: true, source: "customer" });
  });

  it("never returns what the store's tools keep secret", async () => {
    const r = await client.callTool({ name: "get_tool_calls", arguments: { limit: 100 } });
    expect(JSON.stringify(r)).not.toContain("s3cret-PW-9921");
  });
});
