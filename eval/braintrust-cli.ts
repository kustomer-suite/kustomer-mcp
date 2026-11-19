#!/usr/bin/env node
import { readFileSync } from "node:fs";

import { init, flush } from "braintrust";

import { fixture as basicFixture } from "../conformance/fake-api.js";
import { exportSets, type ExportSet, type StoredRecord } from "./braintrust.js";
import { buildHardFixture } from "./fixture-hard.js";
import { buildHardTasks } from "./tasks-hard.js";
import { buildTasks } from "./tasks.js";

// BRAINTRUST_API_KEY=... BRAINTRUST_PROJECT_ID=... node dist/eval/braintrust-cli.js [--dry-run] [--only <experiment name>]
// The key and project id come from the environment only. Nothing is read from or written to a file.

const SETS: Array<Omit<ExportSet, "records">> = [
  { file: "docs/eval-results/2026-11-19-hard-x10-sonnet-5-5.json", label: "hard-sonnet-5.5-x10", suite: "hard" },
  { file: "docs/eval-results/2026-11-19-hard-no-tool-sonnet-5-5.json", label: "hard-sonnet-5.5-no-tool", suite: "hard" },
  { file: "docs/eval-results/2026-11-19-hard-haiku-4-5.json", label: "hard-haiku-4.5", suite: "hard" },
  { file: "docs/eval-results/2026-11-19-hard-haiku-4-5-skill.json", label: "hard-haiku-4.5-skill", suite: "hard" },
  { file: "docs/eval-results/2026-11-19-run3.json", label: "basic-opus-5", suite: "basic" },
  { file: "docs/eval-results/2026-11-19-sonnet-5-5.json", label: "basic-sonnet-5.5", suite: "basic" },
];

const dry = process.argv.includes("--dry-run");
const onlyIdx = process.argv.indexOf("--only");
const only = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : undefined;

const sets: ExportSet[] = SETS.map((s) => ({ ...s, records: (JSON.parse(readFileSync(s.file, "utf8")) as { records: StoredRecord[] }).records }));
const tasks = { basic: buildTasks(basicFixture), hard: buildHardTasks(buildHardFixture()) };

if (dry) {
  const out = await exportSets(sets, tasks, () => ({ log: () => undefined, summarize: async () => ({}) }), only ? (n) => n === only : undefined);
  for (const o of out) console.log(`${o.experiment}: ${o.rows} rows (${o.skippedErrored} errored runs not sent)`);
  console.log("dry run: nothing was sent");
} else {
  const apiKey = process.env.BRAINTRUST_API_KEY;
  const projectId = process.env.BRAINTRUST_PROJECT_ID;
  if (!apiKey) throw new Error("BRAINTRUST_API_KEY is not set");
  if (!projectId) throw new Error("BRAINTRUST_PROJECT_ID is not set");
  const out = await exportSets(
    sets,
    tasks,
    (o) => init({ projectId, apiKey, experiment: o.experiment, description: o.description, metadata: o.metadata, tags: o.tags }) as never,
    only ? (n) => n === only : undefined,
  );
  await flush();
  for (const o of out) console.log(`${o.experiment}: ${o.rows} rows${o.url ? ` -> ${o.url}` : ""}`);
}
