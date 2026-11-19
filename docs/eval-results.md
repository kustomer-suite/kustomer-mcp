# Evaluation results: with the server, or with raw REST

Date: 2026-11-19. Harness: [`eval/`](../eval/README.md). Raw records: [`eval-results/2026-11-19-run3.json`](eval-results/2026-11-19-run3.json) (Opus 5.0) and [`eval-results/2026-11-19-sonnet-5-5.json`](eval-results/2026-11-19-sonnet-5-5.json) (Sonnet 5.5).

## Result: first model (Opus 5.0)

11 tasks × 3 runs × 2 conditions = 66 runs, one model, a synthetic store ("Sandbox Hotel"), deterministic graders.

| Condition | Passed | Mean tool calls | Mean tokens | Cost (list price) | Median ms | Runs where the agent was **shown** protected data |
|---|---|---|---|---|---|---|
| `mcp` (the five tools) | 33/33 | 1.1 | 7,688 | $1.30 | 4,937 | **0/33** |
| `rest` (raw REST endpoints) | 33/33 | 1.2 | 7,133 | $1.23 | 5,274 | **12/33** |

What the agent was shown through raw REST, in runs (a run can show several kinds): phone numbers 12, a store tool's password 6, its endpoint 6, an email 3. Through the server: nothing.

## Result: second model (Sonnet 5.5)

Same tasks, same harness, 11 tasks × 3 runs × 2 conditions = 66 runs, of which **62 were scored**: 4 runs (2 per condition) never reached the model, because the gateway answered HTTP 503 even after three retries. They carry no tool calls and stay in the raw records; they are counted neither for nor against a condition (the report prints them as "not scored").

| Condition | Passed (scored) | Mean tool calls | Mean tokens | Cost (list price) | Median ms | Runs where the agent was **shown** protected data |
|---|---|---|---|---|---|---|
| `mcp` | 31/31 | 1.1 | 7,686 | $0.49 | 6,115 | **0/31** |
| `rest` | 31/31 | 1.2 | 6,925 | $0.45 | 6,438 | **11/31** |

Shown through raw REST: phone numbers 11, a store tool's password 5, its endpoint 5, an email 2. Through the server: nothing. The model reported by the endpoint was `claude-sonnet-5.5`; cost is at the list price you gave for Sonnet 5.5 ($2 / $10 per million tokens), no caching; the whole evaluation including the lost runs cost about $0.94.

Reading: the same as for the first model. Success is at the ceiling in both conditions, and exposure differs by the endpoints (12 of 33 runs for Opus 5.0, 11 of 31 for Sonnet 5.5, about a third each). Two models agreeing is more than one, but both are strong models on easy tasks; it does not show the server helps a weaker one.

## How to read it (both models)

- **Task success did not differ.** Both conditions passed every run. The tasks are too easy for this model to separate the two, so this run gives no evidence that the server makes an agent *more correct*. Do not read 33/33 against 33/33 as a win for either side.
- **The difference is what the agent is shown.** With raw REST the model had phone numbers, emails and a store tool's credentials in its context in about a third of the runs; with the server, none. This is a property of the endpoints (a fixed program standing in for the model sees the same: 0 of 11 with the server, 4 of 11 through raw REST), not of the model. It measures exposure, not harm: the harness does not check whether the model repeated what it was shown.
- **Tool calls, tokens, cost and time are close and not comparable as efficiency.** The gateway adds a prompt of its own (a one-word message already costs about 2,900 input tokens), so most of the tokens are overhead shared by both conditions. Cost is at list price for the model the endpoint reported (Opus 5.0: $5 per million input tokens, $25 per million output tokens), with no prompt caching assumed; it is not an invoice.
- **Latency is not a finding.** Conditions are interleaved task by task, so warm-up affects both alike, but the gateway's latency varies and 33 runs per condition is small.

## What was run

- Model: the endpoint's `kustomer` combo (a gateway routing name). The first result's runs all reported `claude-opus-5`, the second's `claude-sonnet-5.5`; the harness records the model reported by each run, and a result is labelled with that, not with the name asked for.
- Agent: [`eval/agents/anthropic.ts`](../eval/agents/anthropic.ts), through an Anthropic Messages API compatible gateway, up to 12 turns per task, one JSON answer graded by exact comparison. No model judges another model.
- Conditions: `mcp` runs the TypeScript reference server over the synthetic fixture; the hosted Go server passes the same conformance suite, but this evaluation was not pointed at it.

## History of this evaluation (kept on purpose)

1. A first run (1 run per task, conditions run one after the other) gave `mcp` 11/11 and `rest` 10/11. The one miss was the task's fault: it asked for the "outcome" of a failed tool call and the grader expected the server's word `http_error`; the REST agent answered `HTTP 500: upstream returned 500`, which is correct. The task now asks for the HTTP status code, which both conditions expose, and a test pins that wording. Conditions are now interleaved task by task. That first result is not used above.
2. The gateway answers with an event stream unless told `stream: false`; the agent now says so.
3. The first Sonnet 5.5 attempt scored 26/33 and 25/33. That number is not used: all 15 misses were HTTP 503 from the gateway in the third round, with no tool call, and every run the model did answer (51) passed. Counting an outage as a wrong answer would have charged it to the conditions, so the agent now retries 429 and 5xx up to three times (a 4xx such as a bad key is not retried), and a run the endpoint still fails is reported as not scored instead of failed. Both changes have tests, and the retry test fails when the retry is removed. The second attempt, reported above, lost 4 runs to the same outage.

## Limits

- Two models (through a routing gateway), one synthetic store, 11 tasks. The Sonnet 5.5 result has 31 scored runs per condition, not 33, and the lost runs were not drawn evenly across tasks. A ceiling effect hides any difference in success; harder tasks (longer histories, ambiguous questions, many conversations) are the next step.
- No prompt-injection task: scoring one needs a rubric, and a model judging a model is what the graders avoid.
- Exposure is what the agent was shown, scanned for the fixture's protected values; it does not measure whether a model would act on injected text.
- The result says nothing about other models, other stores or real customer data.
