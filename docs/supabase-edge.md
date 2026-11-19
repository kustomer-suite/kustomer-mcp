# The server as a Supabase Edge Function

The TypeScript server, the same five tools and the same contract (`spec/tools.json`), runs as a [Supabase Edge Function](https://supabase.com/docs/guides/functions). It answers from the synthetic "Sandbox Hotel" store that the conformance suite and the evaluation use, so there is no database behind it and no customer data in it.

## What is verified

- The handler (`edge/handler.ts`) is written against Web standard `Request`/`Response`, so Node can test it: `test/edge.test.ts` covers who gets in (closed without its secret, wrong and nearly-right tokens refused, token in the header or in the URL) and runs the conformance checks against it.
- The bundle (`npm run build:edge`, 662 KB) was run in a real Deno 2.1.10 process, and the hosted conformance tests (`test/hosted.test.ts`, 24 tests, skipped unless a URL and token are set) were run against it: **24 of 24 passed**, both directly over Streamable HTTP and through the npm proxy.

## What is not verified

- It has not been deployed to Supabase yet. Deno 2.1.10 in Docker is the same runtime family as Supabase's, not the Supabase runtime itself; cold start, memory and the platform's limits are untested.
- There is no rate limit of its own beyond the platform's.
- Claude Desktop, Cursor and claude.ai have not been pointed at a deployed URL.

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
