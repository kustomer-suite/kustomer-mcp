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

## Deploy

```bash
npm install
npm run build:edge                      # writes supabase/functions/kustomer-mcp/index.ts (generated, not committed)
supabase login
supabase link --project-ref <your-project-ref>
supabase secrets set DEMO_TOKEN="$(openssl rand -hex 24)" DEMO_FIXTURE=hard
supabase functions deploy kustomer-mcp --no-verify-jwt
```

`DEMO_FIXTURE=hard` serves the larger store (51 conversations, a 70-message thread the default window cuts, a failure log to tally, a question the knowledge base does not cover, and three customer messages that try to give the agent orders). `basic` serves the small fixture the conformance suite expects. Without `DEMO_TOKEN` the function refuses every request.

The URL is `https://<ref>.supabase.co/functions/v1/kustomer-mcp`. Use it with the token in a header, or in the URL for clients that cannot send one (claude.ai):

```bash
claude mcp add --transport http kustomer-demo https://<ref>.supabase.co/functions/v1/kustomer-mcp \
  --header "Authorization: Bearer <DEMO_TOKEN>"
# claude.ai: https://<ref>.supabase.co/functions/v1/kustomer-mcp?token=<DEMO_TOKEN>
```

A token in a URL is easier to leak than one in a header; here it protects a synthetic store, and `supabase secrets set DEMO_TOKEN=...` rotates it.
