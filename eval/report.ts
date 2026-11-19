import { anyExposure } from "./exposure.js";
import type { RunRecord } from "./runner.js";
import type { Condition } from "./types.js";

export interface ConditionSummary {
  condition: Condition;
  runs: number; // scored runs: the endpoint answered
  errored: number; // runs lost to an endpoint error (outage, 5xx after retries): kept in the raw records, never scored for or against a condition
  passed: number;
  passRate: number;
  meanToolCalls: number;
  meanTokens: number;
  totalCostUsd: number | null; // null when any run had no price: never a partial sum passed off as a total
  meanMs: number;
  models: string[]; // as reported by the endpoint
  exposedRuns: number; // runs in which the agent was shown at least one protected value
  injectionRuns: number; // scored runs of tasks in the "injection" category
  followedInjection: number; // of those, runs that obeyed the planted instruction
  byCategory: Record<string, { passed: number; runs: number }>;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function summarize(records: RunRecord[]): ConditionSummary[] {
  const conditions = [...new Set(records.map((r) => r.condition))];
  return conditions.map((condition) => {
    const all = records.filter((r) => r.condition === condition);
    const rs = all.filter((r) => r.stoppedBy !== "error");
    const byCategory: ConditionSummary["byCategory"] = {};
    for (const r of rs) {
      const c = (byCategory[r.category] ??= { passed: 0, runs: 0 });
      c.runs++;
      if (r.pass) c.passed++;
    }
    const costs = rs.map((r) => r.costUsd);
    const passed = rs.filter((r) => r.pass).length;
    return {
      condition,
      runs: rs.length,
      errored: all.length - rs.length,
      passed,
      passRate: rs.length ? passed / rs.length : 0,
      meanToolCalls: mean(rs.map((r) => r.toolCalls)),
      meanTokens: mean(rs.map((r) => r.inputTokens + r.outputTokens)),
      totalCostUsd: costs.every((c) => c !== null) ? costs.reduce<number>((a, c) => a + (c ?? 0), 0) : null,
      meanMs: mean(rs.map((r) => r.ms)),
      models: [...new Set(rs.map((r) => r.model ?? "unreported"))].sort(),
      exposedRuns: rs.filter((r) => anyExposure(r.exposure)).length,
      injectionRuns: rs.filter((r) => r.category === "injection").length,
      followedInjection: rs.filter((r) => r.followedInjection).length,
      byCategory,
    };
  });
}

export function toMarkdown(s: ConditionSummary[], meta: { agent: string; tasks: number; runs: number; budgetStopped: boolean }): string {
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
  const cost = (c: number | null) => (c === null ? "n/a (no prices given)" : `$${c.toFixed(4)}`);
  const categories = [...new Set(s.flatMap((c) => Object.keys(c.byCategory)))];
  return [
    `Agent: \`${meta.agent}\` · ${meta.tasks} tasks × ${meta.runs} run(s)${meta.budgetStopped ? " · **stopped early: cost limit reached**" : ""}`,
    "",
    `Model(s) reported by the endpoint: ${[...new Set(s.flatMap((c) => c.models))].join(", ")}`,
    "",
    ...(s.some((c) => c.errored) ? [`Not scored (the endpoint failed, so the model never answered): ${s.map((c) => `${c.condition} ${c.errored}`).join(", ")}. They stay in the raw records.`, ""] : []),
    ...(s.some((c) => c.injectionRuns > 0)
      ? [`Planted instructions obeyed (tasks in the injection category): ${s.map((c) => `${c.condition} ${c.followedInjection}/${c.injectionRuns}`).join(", ")}.`, ""]
      : []),
    "| Condition | Passed | Mean tool calls | Mean tokens | Cost | Mean ms | Runs where the agent was shown protected data |",
    "|---|---|---|---|---|---|---|",
    ...s.map(
      (c) =>
        `| ${c.condition} | ${c.passed}/${c.runs} (${pct(c.passRate)}) | ${c.meanToolCalls.toFixed(1)} | ${c.meanTokens.toFixed(0)} | ${cost(c.totalCostUsd)} | ${c.meanMs.toFixed(0)} | ${c.exposedRuns}/${c.runs} |`,
    ),
    "",
    `| Category | ${s.map((c) => c.condition).join(" | ")} |`,
    `|---|${s.map(() => "---|").join("")}`,
    ...categories.map((cat) => `| ${cat} | ${s.map((c) => (c.byCategory[cat] ? `${c.byCategory[cat].passed}/${c.byCategory[cat].runs}` : "-")).join(" | ")} |`),
  ].join("\n");
}
