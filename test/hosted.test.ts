import { afterAll, beforeAll, describe, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createProxy, type Proxy } from "../src/proxy.js";
import { fixture } from "../conformance/fake-api.js";
import { checks, loadConformanceSpec, type CheckContext } from "../conformance/suite.js";

// The same suite, against a real hosted server seeded with conformance/fixture.json
// (the Go server in the Kustomer Suite API seeds it into its database; see
// docs/conformance-go.md). Skipped unless both variables are set:
//
//   MCP_CONFORMANCE_URL=http://127.0.0.1:8199/mcp MCP_CONFORMANCE_TOKEN=ksm_... npm test
//
// Checks that read the requests a server sent to a fake REST API cannot apply;
// the Go server proves the same properties against its database instead.
const url = process.env.MCP_CONFORMANCE_URL;
const token = process.env.MCP_CONFORMANCE_TOKEN;

describe.skipIf(!url || !token)("conformance: hosted server over Streamable HTTP", () => {
  let ctx: CheckContext;

  beforeAll(async () => {
    const client = new Client({ name: "conformance", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url!), {
        requestInit: { headers: { Authorization: `Bearer ${token}`, "User-Agent": "kustomersuite-mcp-conformance/0" } },
      }),
    );
    ctx = { client, spec: loadConformanceSpec(), fixture };
  });

  afterAll(async () => {
    await ctx?.client.close();
  });

  for (const check of checks.filter((c) => !c.fakeBackend)) {
    it(`${check.id}: ${check.description}`, () => check.run(ctx));
  }
});

// The path a user takes: agent -> stdio -> this proxy -> HTTPS -> hosted server.
describe.skipIf(!url || !token)("conformance: the npm proxy in front of the hosted server", () => {
  let ctx: CheckContext;
  let proxy: Proxy;

  beforeAll(async () => {
    proxy = await createProxy({ token: token!, endpoint: url! });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "conformance", version: "0" });
    await proxy.server.connect(serverSide);
    await client.connect(clientSide);
    ctx = { client, spec: loadConformanceSpec(), fixture };
  });

  afterAll(async () => {
    await ctx?.client.close();
    await proxy?.close();
  });

  for (const check of checks.filter((c) => !c.fakeBackend)) {
    it(`${check.id}: ${check.description}`, () => check.run(ctx));
  }
});
