import { afterAll, beforeAll, describe, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "../src/server.js";
import { fixture, startFakeApi, type FakeApi } from "../conformance/fake-api.js";
import { checks, loadConformanceSpec, type CheckContext } from "../conformance/suite.js";

describe("conformance: TypeScript server against the fake REST API", () => {
  let api: FakeApi;
  let ctx: CheckContext;

  beforeAll(async () => {
    api = await startFakeApi();
    const server = createServer({ baseUrl: api.url, token: fixture.token, storeId: fixture.store.id });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "conformance", version: "0" });
    await server.connect(serverSide);
    await client.connect(clientSide);
    ctx = { client, spec: loadConformanceSpec(), fixture, requests: api.requests };
  });

  afterAll(async () => {
    await ctx?.client.close();
    await api?.close();
  });

  for (const check of checks) {
    it(`${check.id}: ${check.description}`, () => check.run(ctx));
  }
});
