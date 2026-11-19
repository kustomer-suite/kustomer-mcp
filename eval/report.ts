import { anyExposure } from "./exposure.js";
import type { RunRecord } from "./runner.js";
import type { Condition } from "./types.js";

export interface ConditionSummary {
  condition: Condition;
  runs: number;
  passed: number;
  passRate: number;
  meanToolCalls: number;
  meanTokens: number;
  totalCostUsd: number | null; // null when any run had no price: never a partial sum passed off as a total
  meanMs: number;
  models: string[]; // as reported by the endpoint
  exposedRuns: number; // runs in which the agent was shown at least one protected value
  byCategory: Record<string, { passed: number; runs: number }>;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function summarize(records: RunRecord[]): ConditionSummary[] {
  const conditions = [...new Set(records.map((r) => r.condition))];
  return conditions.map((condition) => {
    const rs = records.filter((r) => r.condition === condition);
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
      passed,
      passRate: rs.length ? passed / rs.length : 0,
      meanToolCalls: mean(rs.map((r) => r.toolCalls)),
      meanTokens: mean(rs.map((r) => r.inputTokens + r.outputTokens)),
      totalCostUsd: costs.every((c) => c !== null) ? costs.reduce<number>((a, c) => a + (c ?? 0), 0) : null,
      meanMs: mean(rs.map((r) => r.ms)),
      models: [...new Set(rs.map((r) => r.model ?? "unreported"))].sort(),
      exposedRuns: rs.filter((r) => anyExposure(r.exposure)).length,
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
