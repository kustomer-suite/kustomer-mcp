#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { fixture as basicFixture } from "../conformance/fake-api.js";
import { buildHardFixture } from "./fixture-hard.js";
import { anthropicAgent } from "./agents/anthropic.js";
import { checkGate } from "./gate.js";
import { oracleAgent } from "./agents/oracle.js";
import { summarize, toMarkdown } from "./report.js";
import { runEval } from "./runner.js";
import { startLab } from "./setup.js";
import { buildHardTasks } from "./tasks-hard.js";
import { buildTasks } from "./tasks.js";
import type { Agent, Condition } from "./types.js";

// npm run eval -- --agent oracle [--suite basic|hard] [--conditions mcp,rest,none]
// npm run eval -- --gate      (what CI runs: the oracle on both suites, fails on a regression)
// EVAL_API_URL=... EVAL_API_KEY=... EVAL_MODEL=... npm run eval -- --agent anthropic --runs 3 --max-cost 5
function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

// basic: the eleven tasks on the small store. hard: a larger store with a long
// thread, a failure log to aggregate, a question the knowledge base does not
// cover, and text planted in customer messages (see tasks-hard.ts).
if (process.argv.includes("--gate")) {
  let failed = false;
  for (const [name, fx, mk] of [["basic", basicFixture, buildTasks], ["hard", buildHardFixture(), buildHardTasks]] as const) {
    const lab = await startLab(fx, { nearestAlways: name === "hard" });
    try {
      const { records } = await runEval({
        fixture: fx, tasks: mk(fx), conditions: ["mcp", "rest", "none"], agent: oracleAgent(fx.store.id), runs: 1, limits: { maxTurns: 12 }, makeToolSet: lab.makeToolSet,
      });
      const g = checkGate(records);
      console.log(`gate ${name}: ${g.ok ? "PASS" : "FAIL"} (${records.length} runs)`);
      for (const f of g.failures) console.log(`  - ${f}`);
      if (!g.ok) failed = true;
    } finally {
      await lab.close();
    }
  }
  process.exit(failed ? 1 : 0);
}

const suite = arg("suite", "basic");
if (suite !== "basic" && suite !== "hard") throw new Error(`unknown --suite ${suite} (basic | hard)`);
const fixture = suite === "hard" ? buildHardFixture() : basicFixture;

function agentFromArgs(): Agent {
  const kind = arg("agent", "oracle");
  if (kind === "oracle") return oracleAgent(fixture.store.id);
  if (kind === "anthropic") {
    const need = (k: string) => {
      const v = process.env[k];
      if (!v) throw new Error(`${k} is not set`);
      return v;
    };
    const num = (k: string) => (process.env[k] ? Number(process.env[k]) : undefined);
    return anthropicAgent({
      baseUrl: need("EVAL_API_URL"), apiKey: need("EVAL_API_KEY"), model: need("EVAL_MODEL"),
      skill: process.argv.includes("--skill") ? readFileSync(arg("skill", ""), "utf8").replace(/^---[\s\S]*?---\s*/, "") : undefined, // frontmatter is for the skill loader, not the model
      priceInPerMTok: num("EVAL_PRICE_IN"), priceOutPerMTok: num("EVAL_PRICE_OUT"),
    });
  }
  throw new Error(`unknown --agent ${kind} (oracle | anthropic)`);
}

const agent = agentFromArgs();
const runs = Number(arg("runs", "1"));
const maxCost = process.argv.includes("--max-cost") ? Number(arg("max-cost", "0")) : undefined;
const conditions = arg("conditions", "mcp,rest").split(",") as Condition[];
for (const c of conditions) if (!["mcp", "rest", "none"].includes(c)) throw new Error(`unknown condition ${c} (mcp | rest | none)`);
const tasks = suite === "hard" ? buildHardTasks(fixture) : buildTasks(fixture);

const lab = await startLab(fixture, { nearestAlways: suite === "hard" });
try {
  const outcome = await runEval({
    fixture, tasks, conditions, agent, runs, limits: { maxTurns: 12 }, maxCostUsd: maxCost, makeToolSet: lab.makeToolSet,
  });
  const summary = summarize(outcome.records);
  const md = toMarkdown(summary, { agent: agent.name, tasks: tasks.length, runs, budgetStopped: outcome.budgetStopped });
  const dir = arg("out", "eval-results");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(`${dir}/${agent.name.replace(/[^\w.-]/g, "_")}-${suite}-${stamp}.json`, JSON.stringify({ summary, records: outcome.records }, null, 2));
  writeFileSync(`${dir}/${agent.name.replace(/[^\w.-]/g, "_")}-${suite}-${stamp}.md`, md + "\n");
  console.log(md);
} finally {
  await lab.close();
}
