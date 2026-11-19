# Task-level evaluation: with the server, or with raw REST?

The conformance suite shows the server follows its contract. It does not show the
server **helps an agent**. This harness is for that question, and for a second one
that needs no model at all: what does the agent get *shown*?

## Conditions

| Condition | What the agent has |
|---|---|
| `mcp` | The five tools of the server. |
| `rest` | One `http_request` tool for the REST API's documented endpoints: what an agent has today without the server. |

An agent given only a prompt cannot do any of these tasks (it is 0%, which says
nothing), so it is not used as a baseline.

## Tasks

Eleven tasks on the synthetic "Sandbox Hotel" store (`conformance/fixture.json`),
in five categories: triage (which conversations wait for a human, which are
unread), diagnosis (why the bot did not answer, what price it quoted and from
which document, how confident it was, which tool call failed), knowledge (does
the knowledge base cover check-in time), usage (quota, billed AI tokens) and
isolation (read another store's conversation). Ground truth is derived from the
fixture, so a task cannot drift from its data.

**Grading is deterministic**: the agent ends with one JSON object and a grader
compares it (exact id sets, numbers, required mentions, "not found"). No model
judges another model.

## What is measured

Per condition: tasks passed, tool calls, tokens, cost and time, and **exposure**:
in how many runs the agent was shown a protected value (a store tool's password
or endpoint, a phone number, an email, another store's data), whatever it then did
with it. Costs are never invented: without prices the cost column reads
`n/a (no prices given)`.

## Run it

```
npm run eval -- --agent oracle                      # no model, no key
EVAL_API_URL=... EVAL_API_KEY=... EVAL_MODEL=... \
EVAL_PRICE_IN=... EVAL_PRICE_OUT=...  \             # USD per million tokens; omit for "n/a"
  npm run eval -- --agent anthropic --runs 3 --max-cost 5
```

`--agent anthropic` talks to an Anthropic Messages API compatible endpoint (your
own gateway or the API itself) and stops when `--max-cost` is reached. Results
are written to `eval-results/` as JSON and Markdown.

## Results

A model run (66 runs: 11 tasks × 3 × 2 conditions) is written up in [`docs/eval-results.md`](../docs/eval-results.md): equal success (33/33 each), and the agent was shown protected data in 12/33 raw-REST runs against 0/33 with the server. Read it with its limits: one model, easy tasks, a ceiling effect.

## The oracle, and what it proves

The `oracle` agent is **not a model**: it is a fixed program that solves each task through whichever tool set it is given. It proves that every task is solvable in both conditions and that the graders accept a correct answer; the test suite also checks that an always-wrong agent and an almost-right one are refused. Its exposure result matches the model's (0/11 with the server, 4/11 through raw REST in one pass over the tasks), which is why exposure is a property of the endpoints and not of the model. It is measured against the fake REST API in this repository, built to mirror the real response shapes, not the real service.

## Limits

- 11 tasks, one store, synthetic data; a strong model passes them all, so success cannot separate the conditions.
- No prompt-injection task yet: it needs a rubric, and a model judging a model is exactly what the graders avoid.
- Only one model, through a gateway that adds its own prompt; the harness records the model each run reports.
- The local `mcp` condition goes through the TypeScript reference server. The hosted server passes the same conformance suite, but the evaluation itself has not been pointed at it.
