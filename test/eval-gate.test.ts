import { describe, expect, it } from "vitest";

import { checkGate } from "../eval/gate.js";
import { oracleAgent } from "../eval/agents/oracle.js";
import { fixture } from "../conformance/fake-api.js";
import { runEval, type RunRecord } from "../eval/runner.js";
import { startLab } from "../eval/setup.js";
import { wilson } from "../eval/report.js";
import { buildTasks } from "../eval/tasks.js";

const tasks = buildTasks(fixture);
const records = async (): Promise<RunRecord[]> => {
  const lab = await startLab(fixture);
  try {
    return (await runEval({ fixture, tasks, conditions: ["mcp", "rest", "none"], agent: oracleAgent(fixture.store.id), runs: 1, limits: { maxTurns: 8 }, makeToolSet: lab.makeToolSet })).records;
  } finally {
    await lab.close();
  }
};
const clone = (rs: RunRecord[]) => structuredClone(rs);

describe("the CI quality gate", () => {
  it("passes on the shipped server", async () => {
    const g = checkGate(await records());
    expect(g.failures).toEqual([]);
    expect(g.ok).toBe(true);
  });

  // Each check is shown to fail when the thing it guards breaks; a gate that cannot fail is decoration.
  it("fails when a task cannot be solved through the server", async () => {
    const rs = clone(await records());
    const r = rs.find((x) => x.condition === "mcp")!;
    r.pass = false;
    r.reason = "answer missing";
    expect(checkGate(rs).failures.join("\n")).toContain(`mcp cannot solve ${r.task}`);
  });

  it("fails when the server shows protected data", async () => {
    const rs = clone(await records());
    rs.find((x) => x.condition === "mcp")!.exposure.storeToolSecret = true;
    expect(checkGate(rs).ok).toBe(false);
  });

  it("fails when its controls stop working", async () => {
    const noExposureOnRest = clone(await records());
    for (const r of noExposureOnRest.filter((x) => x.condition === "rest")) for (const k of Object.keys(r.exposure)) (r.exposure as Record<string, boolean>)[k] = false;
    expect(checkGate(noExposureOnRest).failures.join("\n")).toContain("control failed: raw REST exposed nothing");

    const noToolPasses = clone(await records());
    for (const r of noToolPasses.filter((x) => x.condition === "none")) r.pass = true;
    expect(checkGate(noToolPasses).failures.join("\n")).toContain("with no tools");
  });

  it("the no-tool condition has no tools and the oracle cannot solve anything with it", async () => {
    const none = (await records()).filter((r) => r.condition === "none");
    expect(none.length).toBe(tasks.length);
    expect(none.every((r) => r.toolCalls === 0 && !r.pass)).toBe(true);
  });
});

describe("wilson interval", () => {
  it("is wide for few runs and keeps 33/33 and 30/33 apart from certainty", () => {
    const [lo33, hi33] = wilson(33, 33);
    expect(lo33).toBeCloseTo(0.896, 2);
    expect(hi33).toBe(1);
    const [lo30, hi30] = wilson(30, 33);
    expect(lo30).toBeCloseTo(0.764, 2);
    expect(hi30).toBeCloseTo(0.968, 2);
    expect(wilson(0, 0)).toEqual([0, 0]);
  });
});
