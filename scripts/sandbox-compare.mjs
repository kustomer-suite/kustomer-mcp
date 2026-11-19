// Compares what the sandbox answers (the TypeScript server over the cloned database, in this process) with what a
// hosted server answers for the same store, tool by tool, with the same MCP client:
//   SANDBOX_MASK="Name One,Name Two" node node scripts/sandbox-compare.mjs <hosted token file> <postgres url of the sandbox database>
// It needs `npm run build` first (it imports dist/). The clone was scrubbed (emails, phones, links and the --mask names),
// so the same scrub is applied to the hosted answers before they are compared; everything else must be equal, in the same order.
// The hosted token is read from a file and never printed. The hosted server is rate limited, so calls are one per 1.1 s.
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createDbHandler } from "../dist/edge/db-handler.js";
import { handleMcp } from "../dist/edge/handler.js";

const [tokFile, dbUrl] = process.argv.slice(2);
const prodTok = readFileSync(tokFile, "utf8").trim();
const sql = postgres(dbUrl, { max: 1, onnotice: () => {}, connection: { search_path: "public,extensions" } });
const store = (await sql`select value from sandbox.meta where key = 'store'`)[0].value;
const backend = { token: "internal", storeId: store.id, handler: createDbHandler({ sql, storeId: store.id, token: "internal", embed: async () => { throw new Error("no embeddings in this comparison"); }, embeddingModel: "text-embedding-ada-002" }) };
const sbFetch = (input, init) => handleMcp(new Request(input, init), { token: "t", backend });
const sandbox = new Client({ name: "cmp", version: "0" });
await sandbox.connect(new StreamableHTTPClientTransport(new URL("https://sandbox.test/mcp"), { fetch: sbFetch, requestInit: { headers: { Authorization: "Bearer t" } } }));
const prod = new Client({ name: "cmp", version: "0" });
await prod.connect(new StreamableHTTPClientTransport(new URL("https://mcp.kustomersuite.com/mcp"), { requestInit: { headers: { Authorization: `Bearer ${prodTok}`, "User-Agent": "verify/1" } } }));

const rules = JSON.parse(readFileSync("spec/tools.json", "utf8")).redaction.rules.map((r) => [new RegExp(r.pattern, "g"), r.replacement]);
const urlRx = /https?:\/\/[^\s)\]"'<>]+/g;
const names = (process.env.SANDBOX_MASK ?? "").split(",").map((n) => n.trim()).filter(Boolean).map((n) => new RegExp(`(?<![A-Za-z0-9])${n}(?![A-Za-z0-9])`, "gi"));
const scrubText = (t) => { for (const [rx, rep] of rules) t = t.replace(rx, rep); t = t.replace(urlRx, "[link]"); for (const rx of names) t = t.replace(rx, "Budi"); return t; };
// apply to the text of every UntrustedText of what prod answered (the clone was scrubbed the same way)
const scrubTree = (v) => Array.isArray(v) ? v.map(scrubTree) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "text" && typeof x === "string" ? scrubText(x) : scrubTree(x)])) : v;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const canon = (v) => Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;
async function both(name, args) {
  const p = await prod.callTool({ name, arguments: args }); await sleep(1100);
  const s = await sandbox.callTool({ name, arguments: args });
  return { p: canon(scrubTree(p.structuredContent ?? { error: p.content?.[0]?.text })), s: canon(s.structuredContent ?? { error: s.content?.[0]?.text }) };
}
function diffs(a, b, path = "") {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (Array.isArray(a) && Array.isArray(b)) {
    const out = a.length !== b.length ? [`${path}: length prod ${a.length} vs sandbox ${b.length}`] : [];
    for (let i = 0; i < Math.min(a.length, b.length); i++) out.push(...diffs(a[i], b[i], `${path}[${i}]`));
    return out;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const out = [];
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) out.push(...diffs(a[k], b[k], `${path}.${k}`));
    return out;
  }
  return [`${path}: prod ${JSON.stringify(a)?.slice(0, 60)} vs sandbox ${JSON.stringify(b)?.slice(0, 60)}`];
}
const key = (x) => JSON.stringify(x);
const sameSet = (a, b) => key([...a].map(key).sort()) === key([...b].map(key).sort());
const nonIncreasing = (xs) => xs.every((x, i) => i === 0 || xs[i - 1] >= x);
const nonDecreasing = (xs) => xs.every((x, i) => i === 0 || xs[i - 1] <= x);
const summary = {}; const samples = {};
const note = (tool, ok, ds) => { (summary[tool] ??= { same: 0, different: 0 })[ok ? "same" : "different"]++; if (!ok) (samples[tool] ??= []).push(ds.slice(0, 3)); };

// list: both pages
const ids = [];
for (const offset of [0, 50]) {
  const { p, s } = await both("list_conversations", { limit: 50, offset });
  const ds = diffs(p, s); // exact: same items in the same order
  note("list_conversations", ds.length === 0, ds);
  ids.push(...(p.conversations ?? []).map((c) => c.id));
}
console.log("list pages done; conversations on prod:", ids.length);
for (const id of ids) { const { p, s } = await both("get_conversation", { conversation_id: id }); const ds = diffs(p, s); note("get_conversation", ds.length === 0, ds.map((d) => `${id.slice(0, 8)} ${d}`)); }
console.log("conversations done");
for (const args of [{ limit: 100 }, { failed_only: true, limit: 100 }]) { const { p, s } = await both("get_tool_calls", args); const ds = diffs(p, s).map((d) => `${JSON.stringify(args)} ${d}`); note("get_tool_calls", ds.length === 0, ds); }
const withLogs = (await sql`select distinct conversation_id from sandbox.tool_logs where conversation_id is not null`).map((r) => r.conversation_id);
for (const id of withLogs) { const { p, s } = await both("get_tool_calls", { conversation_id: id }); const ds = diffs(p, s).map((d) => `${id.slice(0, 8)} ${d}`); note("get_tool_calls", ds.length === 0, ds); }
{ const { p, s } = await both("get_usage", {}); const ds = diffs(p, s); note("get_usage", ds.length === 0, ds); }
console.log(JSON.stringify(summary, null, 1));
for (const [t, v] of Object.entries(samples)) console.log(t, "first differences:", JSON.stringify(v.slice(0, 4), null, 1));
await sandbox.close(); await prod.close(); await sql.end();
