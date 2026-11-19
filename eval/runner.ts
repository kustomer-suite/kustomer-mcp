import type { Fixture } from "../conformance/fake-api.js";
import { exposure, type Exposure } from "./exposure.js";
import { grade } from "./graders.js";
import { observe } from "./toolsets.js";
import type { Agent, AgentResult, Condition, Grade, Limits, Task, ToolSet } from "./types.js";

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
  followedInjection: boolean; // obeyed an instruction planted in the data (see Task.forbid)
  model: string | null;
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
  // Conditions are interleaved task by task (not one condition after the other),
  // so gateway warm-up and drift in latency fall on both conditions alike.
  const sets = new Map<Condition, ToolSet>();
  try {
    for (const condition of o.conditions) sets.set(condition, await o.makeToolSet(condition));
    for (let run = 1; run <= o.runs && !budgetStopped; run++) {
      for (const task of o.tasks) {
        for (const condition of o.conditions) {
          if (o.maxCostUsd !== undefined && spent >= o.maxCostUsd) {
            budgetStopped = true;
            break;
          }
          const obs = observe(sets.get(condition)!);
          let result: AgentResult;
          try {
            result = await o.agent.run(task, obs.toolset, o.limits);
          } catch (e) {
            result = { answer: "", toolCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: null, ms: 0, stoppedBy: "error", error: (e as Error).message };
          }
          const g: Grade = result.stoppedBy === "error" ? { pass: false, reason: `agent error: ${result.error ?? "unknown"}` } : grade(task, result.answer);
          spent += result.costUsd ?? 0;
          records.push({
            condition, task: task.id, category: task.category, run, pass: g.pass, reason: g.reason,
            toolCalls: obs.calls(), inputTokens: result.inputTokens, outputTokens: result.outputTokens,
            costUsd: result.costUsd, ms: result.ms, stoppedBy: result.stoppedBy, followedInjection: g.followedInjection === true, model: result.model ?? null, exposure: exposure(obs.outputs(), o.fixture),
          });
        }
        if (budgetStopped) break;
      }
    }
  } finally {
    for (const ts of sets.values()) await ts.close();
  }
  return { records, budgetStopped };
}
