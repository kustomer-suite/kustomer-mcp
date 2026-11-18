# Notes for coding agents and contributors

Rules that apply to every commit and pull request in this repository.

1. **No AI attribution.** Commit messages and PR descriptions must not contain
   `Co-Authored-By:` lines for an assistant, session links, or "Generated with"
   footers. If a tool adds them by default, remove them before committing.
2. **Never push to `main`.** Work on a branch and open a pull request. Do not
   force-push `main`.
3. **Never publish to npm from an agent.** Releases (`npm publish`) are done by
   the maintainer. Do not bump the version for a release unless asked.
4. **The contract and the fixture move together.** `spec/tools.json` is the
   tool contract and `conformance/fixture.json` is the data the conformance
   suite and the evaluation are derived from. Change one only with the other
   and re-run `npm test`.
5. **Do not report what was not run.** Tests that need a live server are
   skipped unless `MCP_CONFORMANCE_URL` and `MCP_CONFORMANCE_TOKEN` are set;
   say so when they were skipped. Evaluation numbers must come from a real run,
   never be estimated.

Checks before a PR: `npm run typecheck`, `npm test`, `npm run build`.
