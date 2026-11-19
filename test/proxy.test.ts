import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createProxy, describeConnectError, ProxyError, type Proxy } from "../src/proxy.js";
import { fixture, startFakeApi, type FakeApi } from "../conformance/fake-api.js";
import { checks, loadConformanceSpec, type CheckContext } from "../conformance/suite.js";
import { startRemote, type Remote } from "./support/remote.js";

const TOKEN = "ksm_test_token_for_the_proxy_0123456789";

// The proxy adds nothing and removes nothing: the same conformance suite that
// holds the reference server holds the stdio -> HTTP -> server chain.
describe("conformance through the proxy (stdio side -> HTTP -> hosted server -> fake API)", () => {
  let api: FakeApi;
  let remote: Remote;
  let proxy: Proxy;
  let ctx: CheckContext;

  beforeAll(async () => {
    api = await startFakeApi();
    remote = await startRemote(TOKEN, { baseUrl: api.url, token: fixture.token, storeId: fixture.store.id });
    proxy = await createProxy({ token: TOKEN, endpoint: remote.url });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "conformance", version: "0" });
    await proxy.server.connect(serverSide);
    await client.connect(clientSide);
    ctx = { client, spec: loadConformanceSpec(), fixture, requests: api.requests };
  });

  afterAll(async () => {
    await ctx?.client.close();
    await proxy?.close();
    await remote?.close();
    await api?.close();
  });

  for (const check of checks) {
    it(`${check.id}: ${check.description}`, () => check.run(ctx));
  }
});

describe("proxy start-up", () => {
  it("fails with a clear message when the token is rejected, and never prints it", async () => {
    const api = await startFakeApi();
    const remote = await startRemote(TOKEN, { baseUrl: api.url, token: fixture.token, storeId: fixture.store.id });
    const wrong = "ksm_a_revoked_token_that_must_not_appear_in_output";
    let message = "";
    try {
      await createProxy({ token: wrong, endpoint: remote.url });
    } catch (e) {
      expect(e).toBeInstanceOf(ProxyError);
      message = (e as Error).message;
    } finally {
      await remote.close();
      await api.close();
    }
    expect(message).toContain("401");
    expect(message).toContain("revoked");
    expect(message).not.toContain(wrong);
  });

  it("explains an unreachable server", async () => {
    await expect(createProxy({ token: TOKEN, endpoint: "http://127.0.0.1:1/mcp" })).rejects.toThrow(/Could not reach Kustomer Suite at http:\/\/127\.0\.0\.1:1\/mcp/);
  });

  it("maps status codes to messages without the token", () => {
    expect(describeConnectError({ code: 401 }, "x")).toContain("401");
    expect(describeConnectError({ code: 403 }, "x")).toContain("403");
    expect(describeConnectError({ code: 429 }, "x")).toContain("429");
    expect(describeConnectError(new Error("boom"), "https://h/mcp")).toBe("Could not reach Kustomer Suite at https://h/mcp: boom");
  });
});
