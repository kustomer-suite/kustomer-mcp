import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { fixture as basicFixture, startFakeApi, type FakeApi, type FakeApiOptions, type Fixture } from "../conformance/fake-api.js";
import { createServer } from "../src/server.js";
import { mcpToolSet, noToolSet, restToolSet } from "./toolsets.js";
import type { Condition, ToolSet } from "./types.js";

// The local lab: the synthetic "Sandbox Hotel" store served by a fake REST API.
// Condition "rest" talks to it directly; condition "mcp" goes through the
// TypeScript reference server, which enforces the same contract as the hosted one.
export interface Lab {
  api: FakeApi;
  makeToolSet(condition: Condition): Promise<ToolSet>;
  close(): Promise<void>;
}

export async function startLab(fixture: Fixture = basicFixture, opts: FakeApiOptions = {}): Promise<Lab> {
  const api = await startFakeApi(fixture, opts);
  return {
    api,
    async makeToolSet(condition) {
      if (condition === "none") return noToolSet();
      if (condition === "rest") return restToolSet(api.url, fixture.token);
      const server = createServer({ baseUrl: api.url, token: fixture.token, storeId: fixture.store.id });
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "eval", version: "0" });
      await server.connect(serverSide);
      await client.connect(clientSide);
      return mcpToolSet(client);
    },
    close: () => api.close(),
  };
}
