# The server as a Supabase Edge Function

The TypeScript server, the same five tools and the same contract (`spec/tools.json`), runs as a [Supabase Edge Function](https://supabase.com/docs/guides/functions). It answers from the synthetic "Sandbox Hotel" store that the conformance suite and the evaluation use, so there is no database behind it and no customer data in it.

## What is verified

- The handler (`edge/handler.ts`) is written against Web standard `Request`/`Response`, so Node can test it: `test/edge.test.ts` covers who gets in (closed without its secret, wrong and nearly-right tokens refused, token in the header or in the URL) and runs the conformance checks against it.
- The bundle (`npm run build:edge`, 662 KB) was run in a real Deno 2.1.10 process, and the hosted conformance tests (`test/hosted.test.ts`, 24 tests, skipped unless a URL and token are set) were run against it: **24 of 24 passed**, both directly over Streamable HTTP and through the npm proxy.

## What is not verified

- Cold start and memory under load are not measured. Unauthenticated requests to the deployed function took about 0.1 seconds warm (first call 0.22 seconds, including the TLS handshake); that says nothing about a call that runs a tool.
- There is no rate limit of its own beyond the platform's.
- Claude Desktop, Cursor and claude.ai have not been pointed at the deployed URL.

## Verified on Supabase (2026-11-19)

The maintainer deployed it to a Supabase project. **The 24 hosted conformance tests passed against the deployed function: 24 of 24** (with the `basic` fixture switched on for the run, then switched back to `hard`). With the `hard` fixture, 11 further checks passed from outside: five tools, a store of more than one page, the long thread cut and flagged `truncated`, a planted instruction arriving as wrapped customer text, no store-tool secret in the tool-call output, the search never saying "nothing found", the token in the header or the URL, and 401 without or with a wrong token. Authenticated calls took 0.53 seconds the first time and 0.06 to 0.13 seconds after that. Also from outside: `tools/list` with the demo token returned the five tools with the current contract text; a request without a token or with a wrong one got 401; `OPTIONS` got 204; the response headers (`x-deno-execution-id`, `sb-project-ref`, `x-sb-edge-region`) show it ran on Supabase's edge.

## The database backend (Postgres and pgvector)

The function can answer from Postgres instead of from the bundled fixture (`DEMO_BACKEND=db`). The tables are in a schema called `sandbox` ([`supabase/migrations`](../supabase/migrations)), which the Data API does not expose, and every table has row level security on with no policy. The function connects directly (`SUPABASE_DB_URL`). Search is a real vector search: the query is embedded with the same kind of model production uses (`text-embedding-ada-002`, 1536 dimensions, no vector index, see AGEN-62), then ranked by cosine distance against the stored passages.

Two guards that exist because of what went wrong in production on 2026-11-19:

- **The stored vectors and the query must come from the same model.** ada-002 and `text-embedding-3-small` are both 1536 wide, so nothing fails when they are mixed; the ranking is just wrong (the same text embedded by the two models has a cosine of about 0.006). The model name is stored next to the vectors and the function refuses to search when it differs from the one it embeds with.
- **A public token must not be a way to spend someone's money.** Every search calls a paid API, so searches are counted in the database and refused past a limit per minute, and the key is one made for this sandbox with a spending limit.

If `DEMO_BACKEND=db` is set but the function is not configured for it, it answers 503. It never quietly falls back to the fixture.

**Where the data comes from.** `scripts/sandbox-seed.ts` loads the synthetic fixture into these tables (the tests use it). The deployed sandbox uses a copy of one store of a real (pre-production, test-data) installation, made by `scripts/sandbox-clone.py`: conversations, messages, tool logs, knowledge passages with their existing vectors, and the quota row. By construction it leaves out contacts, phone numbers, IP addresses, metadata, user ids and the tool logs' endpoints, headers and bodies; the free text that remains goes through the redaction rules of `spec/tools.json` (emails, phones), links are replaced except those to hosts listed with `--keep-hosts` (the staging endpoints the store's own tools call are part of the behaviour on show, so the deployed copy keeps them), and given names are replaced; the script then checks its own output and refuses to write a file in which any of that is left. **That file is real data and is not in this repository**: a public git history keeps everything for ever.

**How close to production it is.** `scripts/sandbox-compare.mjs` asks the sandbox (this server over the cloned database) and the hosted production server the same questions with the same MCP client and compares the answers. After applying the same scrub to the hosted answers, with the 92 conversations, 507 messages and 149 tool calls of that store:

- `list_conversations`: both pages of 50, identical, same order.
- `get_conversation`: all 92 conversations identical, same message order; also `max_messages` of 200 and of 5 on the longest thread.
- `get_tool_calls`: the store-wide list (100 and `failed_only`) and every conversation that has calls, identical.
- `get_usage`: identical.
- Filters: `channel`, `handover_status` and every `since` window gave the same answers, but several of those cases have zero or a handful of items on that store, so they match trivially; the substantive proof of the filters is the test suite on the harder fixture.

What the comparison found while it was being built, kept because it is the point of running it: the first run showed differences that turned out to be mine (a column I had cut to whole seconds, so rows microseconds apart were ordered by id; a timestamp written `+00:00` where the API writes `Z`), and one in the TypeScript server itself: it read `status === "unread"`, but the production API answers a boolean `unread` and uses `status` for OPEN, CLOSED and ARCHIVED (AGEN-57), so against the real API it would have reported every conversation as read. It now reads `unread` first and keeps the old convention as a fallback.

**Not compared**: `search_knowledge`, because the comparison needs the sandbox's embedding key and none was available; the search code is tested with a stand-in embedder, not against production. Also: the data is a snapshot (so "today" or "7days" windows empty out as it ages, as they would for a store that stopped getting messages), the quota is the row as it was copied, and ordering uses the timestamps at full precision, as production does; production's order among rows with the identical microsecond is undefined, and the sandbox breaks those by id.

**The evaluation's fixture still uses the old convention** (`status: "unread"` instead of the production `unread` boolean), so the raw-REST condition of the evaluation shows the model a slightly different shape than the real API would. The comparisons between conditions are not affected, but the `rest` condition is not byte-for-byte production REST.

## Deploy

```bash
npm install
npm run build:edge                      # writes supabase/functions/kustomer-mcp/index.ts (generated, not committed)
supabase login
supabase link --project-ref <your-project-ref>
supabase secrets set DEMO_TOKEN="$(openssl rand -hex 24)" DEMO_FIXTURE=hard
supabase functions deploy kustomer-mcp --no-verify-jwt
```

`DEMO_FIXTURE=hard` serves the larger store (56 conversations, a 70-message thread the default window cuts, a failure log to tally, a question the knowledge base does not cover, and three customer messages that try to give the agent orders). `basic` serves the small fixture the conformance suite expects. Without `DEMO_TOKEN` the function refuses every request.

The URL is `https://<ref>.supabase.co/functions/v1/kustomer-mcp`. Use it with the token in a header, or in the URL for clients that cannot send one (claude.ai):

```bash
claude mcp add --transport http kustomer-demo https://<ref>.supabase.co/functions/v1/kustomer-mcp \
  --header "Authorization: Bearer <DEMO_TOKEN>"
# claude.ai: https://<ref>.supabase.co/functions/v1/kustomer-mcp?token=<DEMO_TOKEN>
```

A token in a URL is easier to leak than one in a header; here it protects a synthetic store, and `supabase secrets set DEMO_TOKEN=...` rotates it.

### Deploying the database backend

```bash
supabase db push                         # applies supabase/migrations (the schema); asks for the database password
# the data: the synthetic fixture (reproducible, key needed only for the vectors) ...
node dist/scripts/sandbox-seed.js data supabase/.local/data.sql
OPENAI_API_KEY=... node dist/scripts/sandbox-seed.js embeddings supabase/.local/embeddings.sql   # EMBEDDING_MODEL=text-embedding-ada-002 to match production
# ... or a scrubbed copy of one store (real data: keep it out of git)
python3 scripts/sandbox-clone.py --docker <postgres container> --store-id <uuid> --mask "Name One,Name Two" --out supabase/.local/clone.sql
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/.local/clone.sql      # or data.sql then embeddings.sql
supabase secrets set DEMO_BACKEND=db DEMO_STORE_ID=<store uuid> EMBEDDING_MODEL=text-embedding-ada-002
supabase secrets set OPENAI_API_KEY=...  # a key made for this sandbox, with a spending limit; never the production key
supabase functions deploy kustomer-mcp --no-verify-jwt
```

`supabase/.local/` is git-ignored. `DEMO_BACKEND` unset (or anything but `db`) serves the bundled fixture, which is also the way back.

