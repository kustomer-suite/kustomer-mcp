# Running the conformance suite against the Go server

The Go server lives in the (private) Kustomer Suite API repository. To hold it to
this repository's contract, that repository ships a test harness,
`cmd/mcp-conformance`, which:

1. seeds `conformance/fixture.json` into a Postgres database (two stores, their
   conversations, knowledge base, tool-call logs and quota),
2. serves the production MCP handler (same token middleware, same repositories)
   on a local port, with only the paid embedding call replaced by a stub, and
3. prints a real `ksm_…` access token for the fixture store.

Then, from this repository:

```
MCP_CONFORMANCE_URL=http://127.0.0.1:8199/mcp \
MCP_CONFORMANCE_TOKEN=ksm_… \
npm test -- test/hosted.test.ts
```

Notes:

- Message and document ids are UUIDs in a database, so the suite never compares
  against the fixture's literal ids (`m1-3`): "max_messages keeps the latest" is
  checked against the full thread.
- The check that reads the requests a server sent to a fake REST API
  (`read-tools-have-no-side-effects`) does not apply to a server that reads its
  database. For the Go server the equivalent properties are tested in its own
  repository: reading a conversation leaves `read_at` untouched, and a tenant
  matrix runs all five tools with two stores' tokens against real data.
- The harness deletes and recreates the two fixture stores. It refuses to run
  without `MCP_CONFORMANCE_WIPE=yes` and must only be pointed at a throwaway
  database.
