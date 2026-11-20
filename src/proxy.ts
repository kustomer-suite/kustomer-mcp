import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

import type { ProxyConfig } from "./config.js";

export const PROXY_NAME = "kustomersuite-mcp";
export const PROXY_VERSION = "1.0.0";

export class ProxyError extends Error {}

export interface Proxy {
  server: Server;
  close(): Promise<void>;
}

// A thin proxy: the tools, their schemas, the untrusted-text wrapping, the
// redaction, the rate limits and the audit all live in the hosted server. This
// process only speaks stdio to the agent and forwards to that server with the
// token, so there is one implementation of the contract to get right.
export async function createProxy(cfg: ProxyConfig): Promise<Proxy> {
  const upstream = new Client({ name: PROXY_NAME, version: PROXY_VERSION });
  const transport = new StreamableHTTPClientTransport(new URL(cfg.endpoint), {
    requestInit: { headers: { Authorization: `Bearer ${cfg.token}`, "User-Agent": `${PROXY_NAME}/${PROXY_VERSION}` } },
  });
  try {
    await upstream.connect(transport);
  } catch (err) {
    throw new ProxyError(describeConnectError(err, cfg.endpoint));
  }

  const server = new Server({ name: PROXY_NAME, version: PROXY_VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async (req) => upstream.listTools(req.params));
  server.setRequestHandler(CallToolRequestSchema, async (req) => (await upstream.callTool(req.params)) as CallToolResult);
  return {
    server,
    close: async () => {
      await server.close();
      await upstream.close();
    },
  };
}

// The token is never part of a message.
export function describeConnectError(err: unknown, endpoint: string): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 401) return "Kustomer Suite rejected the token (401): it may be revoked, expired, or not an MCP token.";
  if (code === 403) return "Kustomer Suite refused the token (403): it cannot be used for this.";
  if (code === 429) return "Kustomer Suite is rate limiting this token (429). Try again shortly.";
  const reason = err instanceof Error ? err.message : String(err);
  return `Could not reach Kustomer Suite at ${endpoint}: ${reason}`;
}
