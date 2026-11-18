import { Ajv, type ValidateFunction } from "ajv";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { ApiError, KustomerApi, type ApiConfig } from "./api.js";
import { loadSpec, type ToolSpec } from "./spec.js";
import { handlers, type ToolContext } from "./tools.js";
import { makeRedactor } from "./untrusted.js";

export const SERVER_NAME = "kustomersuite-mcp";
export const SERVER_VERSION = "0.2.0";

interface CompiledTool {
  spec: ToolSpec;
  input: ValidateFunction;
  output: ValidateFunction;
}

// The low-level Server is used on purpose: tool schemas come verbatim from
// spec/tools.json (JSON Schema), the contract shared with the Go server.
export function createServer(cfg: ApiConfig): Server {
  const spec = loadSpec();
  const ajv = new Ajv({ allErrors: true, useDefaults: true, strict: false });
  const tools = new Map<string, CompiledTool>();
  for (const t of spec.tools) {
    if (!handlers[t.name]) throw new Error(`no handler for tool ${t.name}`);
    tools.set(t.name, { spec: t, input: ajv.compile(t.inputSchema), output: ajv.compile(t.outputSchema) });
  }
  const ctx: ToolContext = { api: new KustomerApi(cfg), redact: makeRedactor(spec.redaction.rules) };

  const server = new Server({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: spec.tools.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema as { type: "object" },
      outputSchema: t.outputSchema as { type: "object" },
      annotations: { title: t.title, ...t.annotations },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const tool = tools.get(req.params.name);
    if (!tool) return failure(`Unknown tool: ${req.params.name}`);
    const args = structuredClone(req.params.arguments ?? {});
    if (!tool.input(args)) return failure(`Invalid arguments: ${ajv.errorsText(tool.input.errors)}`);
    let out: Record<string, unknown>;
    try {
      out = await handlers[tool.spec.name]!(args, ctx);
    } catch (err) {
      return failure(describe(err));
    }
    // Never hand a client something the contract does not allow.
    if (!tool.output(out)) {
      console.error(`[${SERVER_NAME}] ${tool.spec.name} output breaks the contract: ${ajv.errorsText(tool.output.errors)}`);
      return failure("The server produced an invalid result; this is a bug in the server.");
    }
    return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
  });

  return server;
}

function failure(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function describe(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401 || err.status === 403) return "Access denied: the token cannot read this for its store.";
    if (err.status === 404) return "Not found in this store.";
    return `Kustomer Suite API error (HTTP ${err.status}).`;
  }
  if (err instanceof Error && err.name === "TimeoutError") return "Kustomer Suite API did not answer in time.";
  return "Kustomer Suite API could not be reached.";
}
