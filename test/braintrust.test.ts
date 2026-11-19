import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { fixture } from "../conformance/fake-api.js";
import { exportSets, toEvent, type ExperimentLike, type ExportSet, type StoredRecord } from "../eval/braintrust.js";
import { buildHardFixture } from "../eval/fixture-hard.js";
import { buildHardTasks } from "../eval/tasks-hard.js";
import { buildTasks } from "../eval/tasks.js";

const noExposure = { storeToolSecret: false, storeToolEndpoint: false, phone: false, email: false, otherStore: false };
const rec = (over: Partial<StoredRecord> = {}): StoredRecord => ({
  condition: "mcp", task: "t1", category: "scale", run: 1, pass: true, reason: "ok", toolCalls: 2, inputTokens: 100, outputTokens: 20,
  costUsd: 0.01, ms: 1500, stoppedBy: "done", followedInjection: false, model: "claude-x", exposure: noExposure, ...over,
});
const set = (records: StoredRecord[]): ExportSet => ({ file: "f.json", label: "lab", suite: "hard", records });
const tasks = { basic: [], hard: [] };

function recorder() {
  const exps: Array<{ name: string; meta: Record<string, unknown>; events: Array<Record<string, unknown>> }> = [];
  const init = (o: { experiment: string; metadata: Record<string, unknown> }): ExperimentLike => {
    const e = { name: o.experiment, meta: o.metadata, events: [] as Array<Record<string, unknown>> };
    exps.push(e);
    return { log: (ev) => void e.events.push(ev as never), summarize: async () => ({ experimentUrl: `https://example.test/${o.experiment}` }) };
  };
  return { exps, init };
}

describe("Braintrust export: the mapping", () => {
  it("scores pass, exposure and (only for injection tasks) obeying a planted instruction", () => {
    const s = set([]);
    expect(toEvent(rec(), undefined, s).scores).toEqual({ pass: 1, no_protected_data: 1 });
    expect(toEvent(rec({ pass: false, exposure: { ...noExposure, phone: true } }), undefined, s).scores).toEqual({ pass: 0, no_protected_data: 0 });
    expect(toEvent(rec({ category: "injection" }), undefined, s).scores.ignored_planted_instruction).toBe(1);
    expect(toEvent(rec({ category: "injection", followedInjection: true, pass: false }), undefined, s).scores.ignored_planted_instruction).toBe(0);
  });

  it("never invents a cost, and counts tokens and seconds", () => {
    const m = toEvent(rec({ costUsd: null }), undefined, set([])).metrics;
    expect(m).not.toHaveProperty("estimated_cost");
    expect(m).toMatchObject({ tokens: 120, prompt_tokens: 100, completion_tokens: 20, latency_s: 1.5, tool_calls: 2 });
    expect(toEvent(rec({ costUsd: 0.5 }), undefined, set([])).metrics.estimated_cost).toBe(0.5);
  });
});

describe("Braintrust export: the experiments", () => {
  it("makes one experiment per condition, skips runs the endpoint failed, and says the data is synthetic", async () => {
    const { exps, init } = recorder();
    const records = [rec(), rec({ run: 2 }), rec({ condition: "rest" }), rec({ condition: "rest", stoppedBy: "error", pass: false })];
    const out = await exportSets([set(records)], tasks, init);
    expect(out.map((o) => [o.experiment, o.rows, o.skippedErrored])).toEqual([["lab-mcp", 2, 0], ["lab-rest", 1, 1]]);
    expect(exps.map((e) => e.name)).toEqual(["lab-mcp", "lab-rest"]);
    expect(exps[0]!.meta).toMatchObject({ synthetic_data_only: true, runs_per_task: 2, condition: "mcp" });
    expect(exps[1]!.events).toHaveLength(1);
    expect(out[0]!.url).toContain("lab-mcp");
  });

  it("can send a single experiment", async () => {
    const { exps, init } = recorder();
    await exportSets([set([rec(), rec({ condition: "rest" })])], tasks, init, (n) => n === "lab-rest");
    expect(exps.map((e) => e.name)).toEqual(["lab-rest"]);
  });
});

// The real result files, through the real task lists: every record must find its task, and nothing secret
// may be in what would be sent.
describe("Braintrust export: the result files that ship", () => {
  const files: Array<[string, "basic" | "hard"]> = [
    ["docs/eval-results/2026-11-19-hard-x10-sonnet-5-5.json", "hard"],
    ["docs/eval-results/2026-11-19-hard-no-tool-sonnet-5-5.json", "hard"],
    ["docs/eval-results/2026-11-19-hard-haiku-4-5.json", "hard"],
    ["docs/eval-results/2026-11-19-hard-haiku-4-5-skill.json", "hard"],
    ["docs/eval-results/2026-11-19-run3.json", "basic"],
    ["docs/eval-results/2026-11-19-sonnet-5-5.json", "basic"],
  ];
  const real = { basic: buildTasks(fixture), hard: buildHardTasks(buildHardFixture()) };

  it("finds the task of every record, and sends nothing that is a secret", async () => {
    const { exps, init } = recorder();
    const sets = files.map(([file, suite], i) => ({ file, label: `s${i}`, suite, records: (JSON.parse(readFileSync(file, "utf8")) as { records: StoredRecord[] }).records }));
    await exportSets(sets, real, init);
    const events = exps.flatMap((e) => e.events);
    expect(events.length).toBeGreaterThan(500);
    expect(events.every((e) => (e.input as { prompt: string | null }).prompt)).toBe(true);
    const all = JSON.stringify(exps);
    expect(all).toContain("Super Cottage"); // the control: the search below can find something that is there
    for (const secret of [fixture.markers.password, fixture.token, "sk-"]) expect(all).not.toContain(secret);
  });
});
