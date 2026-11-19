# Evaluation results: with the server, or with raw REST

Date: 2026-11-19. Harness: [`eval/`](../eval/README.md). Raw records: [`eval-results/2026-11-19-run3.json`](eval-results/2026-11-19-run3.json).

## Result

11 tasks × 3 runs × 2 conditions = 66 runs, one model, a synthetic store ("Sandbox Hotel"), deterministic graders.

| Condition | Passed | Mean tool calls | Mean tokens | Cost (list price) | Median ms | Runs where the agent was **shown** protected data |
|---|---|---|---|---|---|---|
| `mcp` (the five tools) | 33/33 | 1.1 | 7,688 | $1.30 | 4,937 | **0/33** |
| `rest` (raw REST endpoints) | 33/33 | 1.2 | 7,133 | $1.23 | 5,274 | **12/33** |

What the agent was shown through raw REST, in runs (a run can show several kinds): phone numbers 12, a store tool's password 6, its endpoint 6, an email 3. Through the server: nothing.

## How to read it

- **Task success did not differ.** Both conditions passed every run. The tasks are too easy for this model to separate the two, so this run gives no evidence that the server makes an agent *more correct*. Do not read 33/33 against 33/33 as a win for either side.
- **The difference is what the agent is shown.** With raw REST the model had phone numbers, emails and a store tool's credentials in its context in about a third of the runs; with the server, none. This is a property of the endpoints (a fixed program standing in for the model sees the same: 0 of 11 with the server, 4 of 11 through raw REST), not of the model. It measures exposure, not harm: the harness does not check whether the model repeated what it was shown.
- **Tool calls, tokens, cost and time are close and not comparable as efficiency.** The gateway adds a prompt of its own (a one-word message already costs about 2,900 input tokens), so most of the tokens are overhead shared by both conditions. Cost is at list price for the model the endpoint reported (Opus 5.0: $5 per million input tokens, $25 per million output tokens), with no prompt caching assumed; it is not an invoice.
- **Latency is not a finding.** Conditions are interleaved task by task, so warm-up affects both alike, but the gateway's latency varies and 33 runs per condition is small.

## What was run

- Model: the endpoint's `kustomer` combo (a gateway routing name). Every run reported the model `claude-opus-5`; the harness records the model reported by each run.
- Agent: [`eval/agents/anthropic.ts`](../eval/agents/anthropic.ts), through an Anthropic Messages API compatible gateway, up to 12 turns per task, one JSON answer graded by exact comparison. No model judges another model.
- Conditions: `mcp` runs the TypeScript reference server over the synthetic fixture; the hosted Go server passes the same conformance suite, but this evaluation was not pointed at it.

## History of this evaluation (kept on purpose)

1. A first run (1 run per task, conditions run one after the other) gave `mcp` 11/11 and `rest` 10/11. The one miss was the task's fault: it asked for the "outcome" of a failed tool call and the grader expected the server's word `http_error`; the REST agent answered `HTTP 500: upstream returned 500`, which is correct. The task now asks for the HTTP status code, which both conditions expose, and a test pins that wording. Conditions are now interleaved task by task. That first result is not used above.
2. The gateway answers with an event stream unless told `stream: false`; the agent now says so.

## Limits

- One model (through a routing gateway), one synthetic store, 11 tasks. A ceiling effect hides any difference in success; harder tasks (longer histories, ambiguous questions, many conversations) are the next step.
- No prompt-injection task: scoring one needs a rubric, and a model judging a model is what the graders avoid.
- Exposure is what the agent was shown, scanned for the fixture's protected values; it does not measure whether a model would act on injected text.
- The result says nothing about other models, other stores or real customer data.
