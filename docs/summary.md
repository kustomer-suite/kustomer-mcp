# kustomersuite-mcp in one page

A read-only [MCP](https://modelcontextprotocol.io) server that lets an agent such as Claude or Cursor work with a store's customer conversations on an AI customer-service platform: who is waiting for a human, how the bot answered and from which documents, which of the store's tools failed, what the knowledge base covers. Built by Andi Kurniawan; MIT; on npm as `kustomersuite-mcp`.

The server is the smaller part. The point of the project is **how it was checked**: a contract that any server must pass, and a task-level evaluation that asks whether an agent does better with the server than without it.

## What exists

- **A production server** in Go, inside the platform, behind per-store read-only tokens (private repository). **A TypeScript reference server** and an npm stdio proxy (this repository). **The same TypeScript server as a Supabase Edge Function.**
- **One conformance suite** that all of them must pass, through a real MCP client: tenant isolation by listing, by id, by search and in tool calls; customer text always wrapped as untrusted; PII redacted; store-tool secrets never returned.
- **An evaluation harness** with a fixed-program oracle (proves every task is solvable), deterministic graders (no model judges a model), an exposure scanner (what the agent was *shown*), and a harder suite with long threads, aggregation, an uncovered question and three planted prompt injections.

## What was found

| Check | Result |
|---|---|
| Conformance, Go server over real Postgres | 12 of 12 applicable checks, directly and through the npm proxy (24 tests) |
| Conformance, TypeScript server in a Deno process | 24 of 24 |
| Mutation testing: each protection removed, its test must fail | 15 of 15 killed |
| Task success, two models, 11 tasks, with the server vs raw REST | Equal: 33/33 each (Opus 5.0); 31/31 each, 62 of 66 runs scored (Sonnet 5.5) |
| Protected data shown to the agent | Raw REST: 12/33, 11/31 (first suite); 58/110 and 26/55 (hard suite). With the server: 0 in every run |
| Harder suite (paging, long thread, tally, uncovered question, 3 planted injections), Sonnet 5.5, 10 runs per task | Server 110/110, raw REST 105/110 (p = 0.06, not significant); misses on two tallying tasks. Haiku 4.5: 49/55 against 46/55 (no difference). No tools: 5/55. Planted instructions obeyed: 0 of 90 |

On the first suite success did not separate the two conditions: the tasks are too easy. On the harder one the gap kept its direction with more runs (110/110 against 105/110) but is not statistically established (p = 0.06), and a weaker model showed none. What separates the conditions every time is what the agent is shown, and that is a property of the endpoints, not of the model. No model obeyed a planted instruction in either condition (0 of 90), including raw REST, which has no `untrusted` wrapper, so these runs do not show the wrapper to be necessary against these attacks.

## What using it on a real store found

None of these is a leak; a contract suite does not look for them.

- `search_knowledge` returned nothing, or too few results, for some queries: a vector index opened one list, then filtered by store. Through the application's own query, 59 of 166 queries returned nothing and 102 more returned fewer than five. Fixed and deployed; afterwards 10 of 10 queries on production returned the full five.
- A tool description claimed that reading marks messages as read. It was stale; checked on production with an unread conversation, nothing changed. Corrected in both repositories.
- The bot's confidence score is not a truth score: the same question scored 95.8 and 99.4, and an answer scored 86 over-claimed what the knowledge base says.

## What is not done

The harder suite has been run with two models. Claude Desktop and Cursor have not been tried. `search_knowledge` cannot say that the knowledge base does not cover a question. Write tools are designed, not built. Details and numbers: [`case-study.md`](case-study.md), [`eval-results.md`](eval-results.md), [`supabase-edge.md`](supabase-edge.md).
