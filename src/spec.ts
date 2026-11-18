import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type JsonSchema = Record<string, unknown>;

export interface ToolSpec {
  name: string;
  title: string;
  description: string;
  scope: "read" | "write";
  annotations: Record<string, boolean>;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  rest: Record<string, unknown>;
}

export interface RedactionRule {
  name: string;
  pattern: string;
  replacement: string;
}

export interface Spec {
  specVersion: string;
  redaction: { rules: RedactionRule[] };
  $defs: Record<string, JsonSchema>;
  tools: ToolSpec[];
}

// spec/ sits next to src/ in the repository and next to dist/ in the package.
function specPath(): string {
  for (const rel of ["../spec/tools.json", "../../spec/tools.json"]) {
    const p = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(p)) return p;
  }
  throw new Error("spec/tools.json not found");
}

export function loadRawSpec(): Spec {
  return JSON.parse(readFileSync(specPath(), "utf8")) as Spec;
}

// Inline every "#/$defs/X" reference so each tool schema stands alone, as
// MCP clients receive it in tools/list.
export function inlineRefs(node: unknown, defs: Record<string, JsonSchema>): unknown {
  if (Array.isArray(node)) return node.map((n) => inlineRefs(n, defs));
  if (node === null || typeof node !== "object") return node;
  const obj = node as Record<string, unknown>;
  const ref = obj["$ref"];
  if (typeof ref === "string") {
    const name = ref.replace(/^#\/\$defs\//, "");
    const def = defs[name];
    if (!def || name === ref) throw new Error(`unknown $ref ${ref}`);
    const { $ref: _, ...rest } = obj;
    return { ...(inlineRefs(def, defs) as object), ...(inlineRefs(rest, defs) as object) };
  }
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, inlineRefs(v, defs)]));
}

export function loadSpec(): Spec {
  const raw = loadRawSpec();
  return {
    ...raw,
    tools: raw.tools.map((t) => ({
      ...t,
      inputSchema: inlineRefs(t.inputSchema, raw.$defs) as JsonSchema,
      outputSchema: inlineRefs(t.outputSchema, raw.$defs) as JsonSchema,
    })),
  };
}
