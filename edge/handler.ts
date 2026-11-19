import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { fixture as basicFixture, fixtureFetch, type Fixture } from "../conformance/fake-api.js";
import { buildHardFixture } from "../eval/fixture-hard.js";
import { createServer } from "../src/server.js";
import { specFrom, type Spec } from "../src/spec.js";
import specJson from "../spec/tools.json" with { type: "json" };

// The TypeScript server as a Supabase Edge Function (Deno): the same five tools
// and the same contract, answering from the synthetic "Sandbox Hotel" store that
// the conformance suite and the evaluation use. No database, no customer data:
// the data is in the bundle, and the REST client is given a `fetch` that reads it
// (an Edge Function cannot listen on a port, so the fake API's HTTP server is not
// an option). Written against Web standard Request/Response so Node can test it.

export interface EdgeOptions {
  token?: string; // the demo token; unset means every request is refused
  fixture?: "hard" | "basic"; // hard: 51 conversations, a long thread, planted instructions. basic: the conformance fixture.
}

const spec = specFrom(specJson as unknown as Spec);
const hard = buildHardFixture();

const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...extra } });

// Constant-time on equal length; the length itself is not a secret here.
function sameToken(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

export async function handleMcp(req: Request, opts: EdgeOptions): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  // Fail closed: a function deployed without its secret must not be open.
  if (!opts.token) return json(503, { success: false, error: "This demo is not configured." });

  const auth = req.headers.get("authorization") ?? "";
  const presented = auth.startsWith("Bearer ") ? auth.slice(7).trim() : (new URL(req.url).searchParams.get("token") ?? "").trim();
  if (!sameToken(presented, opts.token)) return json(401, { success: false, error: "Invalid token" });

  // Stateless, like the hosted server: one POST, one JSON answer.
  if (req.method !== "POST") return json(405, { success: false, error: "Use POST" }, { Allow: "POST" });

  const basic = opts.fixture === "basic";
  const fx: Fixture = basic ? basicFixture : hard;
  const server = createServer(
    { baseUrl: "http://fixture.invalid", token: fx.token, storeId: fx.store.id, fetch: fixtureFetch(fx, { nearestAlways: !basic }) },
    spec,
  );
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    await server.close();
  }
}
