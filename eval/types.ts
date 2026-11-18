// Task-level evaluation: does an agent do better with the MCP server than with
// the access it would otherwise have (raw REST)? These are the shared types.

export type Condition = "mcp" | "rest";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// What an agent is allowed to do in one condition. `call` returns the text the
// agent sees, which is also what is scanned for exposure.
export interface ToolSet {
  condition: Condition;
  tools: ToolDef[];
  call(name: string, args: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

export type Expectation =
  | { kind: "ids"; ids: string[] } // answer.ids is exactly this set
  | { kind: "fields"; fields: Record<string, string | number | boolean> } // answer has these values
  | { kind: "mentions"; field: string; all: string[] } // answer[field] mentions every string
  | { kind: "not_found" }; // answer.found === false

export interface Task {
  id: string;
  category: string;
  prompt: string; // ends with the JSON shape the agent must answer with
  expect: Expectation;
}

export interface Limits {
  maxTurns: number;
}

export interface AgentResult {
  answer: string;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null; // null when prices were not supplied: never invented
  ms: number;
  stoppedBy: "done" | "turns" | "error";
  error?: string;
}

export interface Agent {
  name: string;
  run(task: Task, tools: ToolSet, limits: Limits): Promise<AgentResult>;
}

export interface Grade {
  pass: boolean;
  reason: string;
}
