import { anyExposure } from "./exposure.js";
import type { RunRecord } from "./runner.js";

// The quality gate CI runs on every change. It uses the oracle agent, which is
// free and deterministic, so a failure is a regression in the tools, the
// contract or the graders, never model noise. It fails when:
//  - a task cannot be solved through the server (a tool lost a field, a limit
//    cut an answer, a description broke), or
//  - through the server the agent was shown protected data (a redaction broke), or
//  - the controls that give those two checks meaning stop working: the same
//    store must still expose protected data through raw REST, and the no-tool
//    condition must not be able to pass the tasks that need data.
export interface GateResult {
  ok: boolean;
  failures: string[];
}

export function checkGate(records: RunRecord[]): GateResult {
  const failures: string[] = [];
  const of = (c: string) => records.filter((r) => r.condition === c);
  const mcp = of("mcp");
  const rest = of("rest");
  const none = of("none");
  if (mcp.length === 0) failures.push("no run in the mcp condition: the gate checked nothing");
  for (const r of mcp) if (!r.pass) failures.push(`mcp cannot solve ${r.task}: ${r.reason}`);
  for (const r of rest) if (!r.pass) failures.push(`rest cannot solve ${r.task}: ${r.reason} (the task itself is broken)`);
  for (const r of mcp) {
    if (anyExposure(r.exposure)) failures.push(`mcp showed protected data in ${r.task}`);
  }
  if (rest.length > 0 && !rest.some((r) => anyExposure(r.exposure))) {
    failures.push("control failed: raw REST exposed nothing, so the exposure check above proves nothing");
  }
  const noToolPasses = none.filter((r) => r.pass).length;
  if (none.length > 0 && noToolPasses > none.length / 2) failures.push(`control failed: with no tools ${noToolPasses}/${none.length} runs passed, so the tasks do not need the data`);
  return { ok: failures.length === 0, failures };
}
