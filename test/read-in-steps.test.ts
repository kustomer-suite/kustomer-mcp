import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { fixtureFetch } from "../conformance/fake-api.js";
import { buildHardFixture, HARD } from "../eval/fixture-hard.js";
import { createServer } from "../src/server.js";

// get_conversation cuts a long thread to its most recent max_messages. `before` / `next_before` let an agent read the
// rest in steps. The hard fixture has a 70-message thread whose question is about its very first message.
const fx = buildHardFixture();

async function connect(): Promise<Client> {
  const server = createServer({ baseUrl: "http://api.invalid", token: fx.token, storeId: fx.store.id, fetch: fixtureFetch(fx) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await server.connect(b);
  await client.connect(a);
  return client;
}
type Page = { messages: Array<{ id: string }>; truncated: boolean; next_before?: string };
const read = async (c: Client, args: Record<string, unknown>) => (await c.callTool({ name: "get_conversation", arguments: { conversation_id: HARD.longThread, ...args } }));

describe("reading a long thread in steps", () => {
  it("walks back through all 70 messages once, in order, ending at the first", async () => {
    const c = await connect();
    const everything = (await read(c, { max_messages: 200 })).structuredContent as Page;
    expect(everything.messages).toHaveLength(70);
    expect(everything.truncated).toBe(false);
    expect(everything.next_before).toBeUndefined();

    const pages: string[][] = [];
    let before: string | undefined;
    for (let i = 0; i < 10; i++) {
      const p = (await read(c, before ? { max_messages: 30, before } : { max_messages: 30 })).structuredContent as Page;
      pages.unshift(p.messages.map((m) => m.id));
      if (!p.truncated) { expect(p.next_before).toBeUndefined(); break; }
      before = p.next_before!;
      expect(before).toBe(p.messages[0]!.id);
    }
    expect(pages.map((p) => p.length)).toEqual([10, 30, 30]);
    expect(pages.flat()).toEqual(everything.messages.map((m) => m.id));
    await c.close();
  });

  it("without before the answer is what it was: the latest 50, truncated, now with next_before", async () => {
    const c = await connect();
    const p = (await read(c, {})).structuredContent as Page;
    expect(p.messages).toHaveLength(50);
    expect(p.truncated).toBe(true);
    expect(p.next_before).toBe(p.messages[0]!.id);
  });

  it("a before that is not a message of the conversation is an error, and says nothing about other stores", async () => {
    const c = await connect();
    for (const bad of ["00000000-0000-4000-8000-000000000000", "L-1-not-there"]) {
      const r = await read(c, { before: bad });
      expect(r.isError).toBe(true);
      expect(JSON.stringify(r.content)).toContain("Not found in this store");
    }
    // another conversation's message id is just as unknown here
    const other = fx.conversations.find((x) => x.id !== HARD.longThread && (x as { messages?: Array<{ id: string }> }).messages?.length) as { messages: Array<{ id: string }> };
    const r = await read(c, { before: other.messages[0]!.id });
    expect(r.isError).toBe(true);
    await c.close();
  });

  it("before on the very first message leaves nothing before it", async () => {
    const c = await connect();
    const first = ((await read(c, { max_messages: 200 })).structuredContent as Page).messages[0]!.id;
    const p = (await read(c, { before: first })).structuredContent as Page;
    expect(p.messages).toEqual([]);
    expect(p.truncated).toBe(false);
    await c.close();
  });
});
