import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "../src/server.js";

// Production's API answers {"unread": bool} and keeps `status` for the lifecycle (OPEN | CLOSED | ARCHIVED),
// so a server that read `status === "unread"` reported every conversation as read. The fixtures
// still use the older convention, so both must work, and the explicit field must win.
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "aaaaaaaa-0000-4000-8000-000000000002";
const C = "aaaaaaaa-0000-4000-8000-000000000003";

async function listWith(items: unknown[]): Promise<Array<{ id: string; unread: boolean }>> {
  const fetchStub: typeof fetch = async () => new Response(JSON.stringify({ success: true, data: { items, total: items.length, limit: 20, offset: 0 } }), { status: 200, headers: { "Content-Type": "application/json" } });
  const server = createServer({ baseUrl: "http://api.invalid", token: "t", storeId: "11111111-1111-4111-8111-111111111111", fetch: fetchStub });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await server.connect(b);
  await client.connect(a);
  const r = (await client.callTool({ name: "list_conversations", arguments: {} })).structuredContent as { conversations: Array<{ id: string; unread: boolean }> };
  await client.close();
  return r.conversations;
}

describe("unread", () => {
  it("reads the API's own `unread` field, whatever `status` says", async () => {
    const r = await listWith([
      { id: A, channel: "whatsapp", status: "OPEN", unread: true },
      { id: B, channel: "whatsapp", status: "OPEN", unread: false },
      { id: C, channel: "whatsapp", status: "unread", unread: false }, // the explicit field wins
    ]);
    expect(r.map((c) => c.unread)).toEqual([true, false, false]);
  });

  it("still understands the older `status: unread` when the field is absent", async () => {
    const r = await listWith([{ id: A, channel: "whatsapp", status: "unread" }, { id: B, channel: "whatsapp", status: "read" }]);
    expect(r.map((c) => c.unread)).toEqual([true, false]);
  });
});
