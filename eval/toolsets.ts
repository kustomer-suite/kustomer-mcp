import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

import type { Condition, ToolDef, ToolSet } from "./types.js";

// Condition "mcp": the five tools of the server, as the server describes them.
export async function mcpToolSet(client: Client): Promise<ToolSet> {
  const listed = await client.listTools();
  const tools: ToolDef[] = listed.tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    inputSchema: t.inputSchema as Record<string, unknown>,
  }));
  return {
    condition: "mcp",
    tools,
    async call(name, args) {
      const r = await client.callTool({ name, arguments: args });
      const text = ((r.content ?? []) as Array<{ text?: string }>).map((c) => c.text ?? "").join("\n");
      return r.isError ? `ERROR: ${text}` : text;
    },
    close: () => client.close(),
  };
}

const REST_HELP = `Make one HTTP request to the Kustomer Suite REST API. Responses are JSON: {"success": true, "data": ...}.
Endpoints you may use:
  GET  /api/v1/conversations?store_id=<id>&handover_status=<pending|taken|closed>&limit=<n>
  GET  /api/v1/conversations/<conversation id>
  GET  /api/v1/stores/<store id>/tool-execution-logs?conversation_id=<id>
  GET  /api/v1/dashboard/quota?store_id=<id>
  POST /api/v1/knowledge-base/search   body {"store_id": "<id>", "query": "<text>", "limit": <n>}`;

// Condition "rest": what an agent has without the server, raw access to the
// same REST API (an agent given only a prompt can do none of these tasks, so it
// is no baseline). Only the endpoints above are reachable.
export function restToolSet(baseUrl: string, token: string): ToolSet {
  const tool: ToolDef = {
    name: "http_request",
    description: REST_HELP,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["method", "path"],
      properties: {
        method: { enum: ["GET", "POST"] },
        path: { type: "string", description: "starts with /api/v1/" },
        query: { type: "object", additionalProperties: { type: "string" } },
        body: { type: "object" },
      },
    },
  };
  return {
    condition: "rest",
    tools: [tool],
    async call(name, args) {
      if (name !== tool.name) return `ERROR: unknown tool ${name}`;
      const method = String(args.method);
      const path = String(args.path ?? "");
      if (!path.startsWith("/api/v1/") || path.includes("..")) return "ERROR: path must start with /api/v1/";
      if (method === "POST" && path !== "/api/v1/knowledge-base/search") return "ERROR: POST is only allowed for the knowledge base search";
      if (method !== "GET" && method !== "POST") return "ERROR: method must be GET or POST";
      const url = new URL(path, baseUrl);
      for (const [k, v] of Object.entries((args.query as Record<string, string> | undefined) ?? {})) url.searchParams.set(k, String(v));
      const res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: method === "POST" ? JSON.stringify(args.body ?? {}) : undefined,
      });
      return `HTTP ${res.status}\n${await res.text()}`;
    },
    close: async () => {},
  };
}

// Counts the calls an agent makes and keeps everything it was shown.
export function observe(ts: ToolSet): { toolset: ToolSet; calls: () => number; outputs: () => string[] } {
  let calls = 0;
  const outputs: string[] = [];
  return {
    toolset: {
      ...ts,
      async call(name, args) {
        calls++;
        const out = await ts.call(name, args);
        outputs.push(out);
        return out;
      },
    },
    calls: () => calls,
    outputs: () => outputs,
  };
}

export type { Condition };
