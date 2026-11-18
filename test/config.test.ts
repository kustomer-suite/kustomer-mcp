import { describe, expect, it } from "vitest";

import { ENDPOINT, loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("needs only the token, and the endpoint is the hosted server", () => {
    expect(loadConfig({ KUSTOMER_TOKEN: "ksm_abc123" })).toEqual({ token: "ksm_abc123", endpoint: ENDPOINT });
    expect(ENDPOINT).toBe("https://mcp.kustomersuite.com/mcp");
  });

  it("trims whitespace around a pasted token", () => {
    expect(loadConfig({ KUSTOMER_TOKEN: "  ksm_abc123\n" }).token).toBe("ksm_abc123");
  });

  it("refuses a missing or empty token", () => {
    expect(() => loadConfig({})).toThrow("KUSTOMER_TOKEN is not set");
    expect(() => loadConfig({ KUSTOMER_TOKEN: "   " })).toThrow("KUSTOMER_TOKEN is not set");
  });

  it("refuses something that is not an MCP token, without echoing it", () => {
    let message = "";
    try {
      loadConfig({ KUSTOMER_TOKEN: "sk-live-supersecret" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("ksm_");
    expect(message).not.toContain("supersecret");
  });

  // A token must never be sent to a host the user (or an attacker who can set
  // an environment variable) chose: the old KUSTOMER_API_URL and the store id
  // are gone, and setting them changes nothing.
  it("ignores KUSTOMER_API_URL, KUSTOMER_URL and KUSTOMER_STORE_ID", () => {
    const cfg = loadConfig({
      KUSTOMER_TOKEN: "ksm_abc123",
      KUSTOMER_API_URL: "https://evil.example",
      KUSTOMER_URL: "https://evil.example",
      KUSTOMER_STORE_ID: "11111111-1111-4111-8111-111111111111",
    });
    expect(cfg).toEqual({ token: "ksm_abc123", endpoint: ENDPOINT });
  });
});
