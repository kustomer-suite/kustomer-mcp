import { anyExposure, type Exposure } from "./exposure.js";
import type { Expectation, Task } from "./types.js";

// Sends results the evaluation already produced to Braintrust, as experiments, so
// they can be compared there (the `mcp` experiment next to the `rest` one). It
// calls no model: the numbers are the ones in the result files. Only synthetic
// data goes out (the fixtures are made up), and a run the endpoint failed is not
// sent, as it is not scored anywhere else.
//
// The result files keep the verdict and the reason, not the model's answer text,
// so `output` carries those, not the answer.

export interface StoredRecord {
  condition: string;
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
  followedInjection?: boolean;
  model: string | null;
  exposure: Exposure;
}

export interface ExperimentLike {
  log(event: {
    input: unknown;
    output: unknown;
    expected?: unknown;
    scores: Record<string, number | null>;
    metadata?: Record<string, unknown>;
    metrics?: Record<string, number>;
    tags?: string[];
  }): unknown;
  summarize(): Promise<{ experimentUrl?: string }>;
}

export type InitExperiment = (opts: { experiment: string; description: string; metadata: Record<string, unknown>; tags: string[] }) => ExperimentLike;

export interface ExportSet {
  file: string; // where the records came from, kept in the metadata
  label: string; // e.g. "hard-sonnet-5.5-x10"; the experiment is `${label}-${condition}`
  suite: "basic" | "hard";
  records: StoredRecord[];
}

export interface ExportOutcome {
  experiment: string;
  rows: number;
  skippedErrored: number;
  url?: string;
}

export function toEvent(r: StoredRecord, task: Task | undefined, set: ExportSet) {
  const exposed = anyExposure(r.exposure);
  const scores: Record<string, number | null> = { pass: r.pass ? 1 : 0, no_protected_data: exposed ? 0 : 1 };
  // Only the injection tasks can be obeyed; for the others the score is left out, not set to a flattering 1.
  if (r.category === "injection") scores.ignored_planted_instruction = r.followedInjection ? 0 : 1;
  const metrics: Record<string, number> = {
    tool_calls: r.toolCalls,
    prompt_tokens: r.inputTokens,
    completion_tokens: r.outputTokens,
    tokens: r.inputTokens + r.outputTokens,
    latency_s: r.ms / 1000,
  };
  if (r.costUsd !== null) metrics.estimated_cost = r.costUsd;
  return {
    input: { task: r.task, prompt: task?.prompt ?? null },
    output: { passed: r.pass, reason: r.reason, stopped_by: r.stoppedBy },
    expected: (task?.expect as Expectation | undefined) ?? undefined,
    scores,
    metrics,
    metadata: { run: r.run, condition: r.condition, category: r.category, model: r.model, suite: set.suite, exposure: r.exposure },
    tags: [r.category, r.condition],
  };
}

export async function exportSets(
  sets: ExportSet[],
  tasksBySuite: Record<"basic" | "hard", Task[]>,
  init: InitExperiment,
  only?: (experiment: string) => boolean,
): Promise<ExportOutcome[]> {
  const out: ExportOutcome[] = [];
  for (const set of sets) {
    const conditions = [...new Set(set.records.map((r) => r.condition))];
    for (const condition of conditions) {
      const name = `${set.label}-${condition}`;
      if (only && !only(name)) continue;
      const all = set.records.filter((r) => r.condition === condition);
      const scored = all.filter((r) => r.stoppedBy !== "error");
      const runs = Math.max(...scored.map((r) => r.run), 0);
      const exp = init({
        experiment: name,
        description: `Synthetic store, ${set.suite} suite, ${runs} run(s) per task. Results exported from ${set.file}; no model was called for this export.`,
        metadata: { suite: set.suite, condition, runs_per_task: runs, source: set.file, models: [...new Set(scored.map((r) => r.model))], synthetic_data_only: true },
        tags: [set.suite, condition],
      });
      for (const r of scored) exp.log(toEvent(r, tasksBySuite[set.suite].find((t) => t.id === r.task), set));
      const summary = await exp.summarize();
      out.push({ experiment: name, rows: scored.length, skippedErrored: all.length - scored.length, url: summary.experimentUrl });
    }
  }
  return out;
}
