import type { Fixture } from "../conformance/fake-api.js";
import { exposure, type Exposure } from "./exposure.js";
import { grade } from "./graders.js";
import { observe } from "./toolsets.js";
import type { Agent, AgentResult, Condition, Limits, Task, ToolSet } from "./types.js";

export interface RunRecord {
  condition: Condition;
  task: string;
  category: string;
  run: number;
  pass: boolean;
  reason: string;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  ms: number;
  stoppedBy: string;
  exposure: Exposure;
}

export interface RunOptions {
  fixture: Fixture;
  tasks: Task[];
  conditions: Condition[];
  agent: Agent;
  runs: number;
  limits: Limits;
  maxCostUsd?: number; // stop when the summed cost reaches it
  makeToolSet(condition: Condition): Promise<ToolSet>;
}

export interface RunOutcome {
  records: RunRecord[];
  budgetStopped: boolean;
}

export async function runEval(o: RunOptions): Promise<RunOutcome> {
  const records: RunRecord[] = [];
  let spent = 0;
  let budgetStopped = false;
  for (const condition of o.conditions) {
    const ts = await o.makeToolSet(condition);
    try {
      for (let run = 1; run <= o.runs && !budgetStopped; run++) {
        for (const task of o.tasks) {
          if (o.maxCostUsd !== undefined && spent >= o.maxCostUsd) {
            budgetStopped = true;
            break;
          }
          const obs = observe(ts);
          let result: AgentResult;
          try {
            result = await o.agent.run(task, obs.toolset, o.limits);
          } catch (e) {
            result = { answer: "", toolCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: null, ms: 0, stoppedBy: "error", error: (e as Error).message };
          }
          const g = result.stoppedBy === "error" ? { pass: false, reason: `agent error: ${result.error ?? "unknown"}` } : grade(task, result.answer);
          spent += result.costUsd ?? 0;
          records.push({
            condition, task: task.id, category: task.category, run, pass: g.pass, reason: g.reason,
            toolCalls: obs.calls(), inputTokens: result.inputTokens, outputTokens: result.outputTokens,
            costUsd: result.costUsd, ms: result.ms, stoppedBy: result.stoppedBy, exposure: exposure(obs.outputs(), o.fixture),
          });
        }
      }
    } finally {
      await ts.close();
    }
  }
  return { records, budgetStopped };
}
