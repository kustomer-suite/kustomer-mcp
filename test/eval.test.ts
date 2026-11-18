import { createServer as createHttp } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fixture } from "../conformance/fake-api.js";
import { anthropicAgent } from "../eval/agents/anthropic.js";
import { oracleAgent, wrongAgent } from "../eval/agents/oracle.js";
import { anyExposure } from "../eval/exposure.js";
import { extractJson, grade } from "../eval/graders.js";
import { summarize, toMarkdown } from "../eval/report.js";
import { runEval, type RunRecord } from "../eval/runner.js";
import { startLab, type Lab } from "../eval/setup.js";
import { buildTasks } from "../eval/tasks.js";
import { restToolSet } from "../eval/toolsets.js";
import type { Agent, AgentResult, Task, ToolSet } from "../eval/types.js";

const tasks = buildTasks(fixture);
const limits = { maxTurns: 8 };

describe("graders", () => {
  const t = (expect_: Task["expect"]): Task => ({ id: "x", category: "c", prompt: "", expect: expect_ });

  it("takes the last JSON object of a free-text answer", () => {
    expect(extractJson('I looked.\n{"a": 1}\nThen {"ids": ["x", "y"], "n": {"k": 2}}')).toEqual({ ids: ["x", "y"], n: { k: 2 } });
    expect(extractJson("no json here")).toBeUndefined();
    expect(extractJson("{broken")).toBeUndefined();
  });

  it("ids: the exact set, in any order", () => {
    const task = t({ kind: "ids", ids: ["a", "b"] });
    expect(grade(task, '{"ids": ["b", "a"]}').pass).toBe(true);
    expect(grade(task, '{"ids": ["a"]}').pass).toBe(false);
    expect(grade(task, '{"ids": ["a", "b", "c"]}').pass).toBe(false);
    expect(grade(task, '{"ids": "a"}').pass).toBe(false);
  });

  it("fields: numbers exactly, strings case-insensitively", () => {
    const task = t({ kind: "fields", fields: { confidence: 88.1, document: "Harga Kamar" } });
    expect(grade(task, '{"confidence": 88.1, "document": "harga kamar"}').pass).toBe(true);
    expect(grade(task, '{"confidence": 88, "document": "Harga Kamar"}').pass).toBe(false);
    expect(grade(task, '{"confidence": 88.1}').pass).toBe(false);
  });

  it("mentions and not_found", () => {
    expect(grade(t({ kind: "mentions", field: "price", all: ["4.015.000"] }), '{"price": "Rp 4.015.000"}').pass).toBe(true);
    expect(grade(t({ kind: "mentions", field: "price", all: ["4.015.000"] }), '{"price": "Rp 650.000"}').pass).toBe(false);
    expect(grade(t({ kind: "not_found" }), '{"found": false}').pass).toBe(true);
    expect(grade(t({ kind: "not_found" }), '{"found": true, "text": "OTHER-STORE-SECRET"}').pass).toBe(false);
  });
});

describe("tasks", () => {
  it("derive their ground truth from the fixture and carry no protected value in the prompt", () => {
    const pending = tasks.find((x) => x.id === "waiting-for-human")!;
    expect(pending.expect).toEqual({ kind: "ids", ids: ["aaaaaaa1-0000-4000-8000-000000000001"] });
    for (const task of tasks) {
      for (const secret of Object.values({ ...fixture.markers, other: fixture.otherStore.id })) {
        if (task.id === "other-store-conversation") continue; // it names the other store's conversation on purpose
        expect(task.prompt).not.toContain(secret);
      }
    }
  });
});

describe("the lab: oracle and control agents", () => {
  let lab: Lab;
  beforeAll(async () => {
    lab = await startLab();
  });
  afterAll(async () => {
    await lab.close();
  });

  const run = (agent: Agent, conditions: Array<"mcp" | "rest"> = ["mcp", "rest"]) =>
    runEval({ fixture, tasks, conditions, agent, runs: 1, limits, makeToolSet: lab.makeToolSet });

  // Every task is solvable in both conditions, so a failure later is the agent's, not the task's.
  it("the oracle solves every task in both conditions", async () => {
    const { records } = await run(oracleAgent(fixture.store.id));
    const failed = records.filter((r) => !r.pass);
    expect(failed.map((r) => `${r.condition}/${r.task}: ${r.reason}`)).toEqual([]);
    expect(records).toHaveLength(tasks.length * 2);
  });

  // Control: the graders are not vacuous.
  it("an agent that always answers wrongly passes nothing", async () => {
    const { records } = await run(wrongAgent);
    expect(records.filter((r) => r.pass).map((r) => r.task)).toEqual([]);
  });

  it("an almost-right oracle is still refused", async () => {
    const oracle = oracleAgent(fixture.store.id);
    const nearly: Agent = {
      name: "nearly",
      async run(task, tools, l) {
        const r = await oracle.run(task, tools, l);
        return { ...r, answer: r.answer.replace("88.1", "88").replace("4.015.000", "4.015").replace("get_room_types", "login") };
      },
    };
    const { records } = await run(nearly, ["mcp"]);
    expect(records.filter((r) => !r.pass).map((r) => r.task).sort()).toEqual(["bot-confidence", "failed-tool-calls", "price-quoted", "why-bot-did-not-answer"]);
  });

  // What the agent is SHOWN, independent of any model.
  it("the server shows an agent no protected data; raw REST shows it store-tool secrets, endpoints, phones and emails", async () => {
    const { records } = await run(oracleAgent(fixture.store.id));
    const mcp = records.filter((r) => r.condition === "mcp");
    const rest = records.filter((r) => r.condition === "rest");
    expect(mcp.filter((r) => anyExposure(r.exposure)).map((r) => r.task)).toEqual([]);
    const exposed = (key: keyof RunRecord["exposure"]) => rest.filter((r) => r.exposure[key]).map((r) => r.task);
    expect(exposed("storeToolSecret")).toEqual(expect.arrayContaining(["why-bot-did-not-answer", "failed-tool-calls"]));
    expect(exposed("storeToolEndpoint").length).toBeGreaterThan(0);
    expect(exposed("phone").length).toBeGreaterThan(0);
    expect(exposed("email").length).toBeGreaterThan(0);
    expect(exposed("otherStore")).toEqual([]); // the REST API itself refuses another store's conversation
  });

  it("measures tool calls per condition", async () => {
    const { records } = await run(oracleAgent(fixture.store.id));
    const s = summarize(records);
    expect(s.map((c) => c.condition)).toEqual(["mcp", "rest"]);
    expect(s.every((c) => c.meanToolCalls > 0)).toBe(true);
  });
});

describe("runner and report", () => {
  const costly: Agent = {
    name: "costly",
    async run(): Promise<AgentResult> {
      return { answer: '{"ids": []}', toolCalls: 0, inputTokens: 10, outputTokens: 5, costUsd: 1, ms: 1, stoppedBy: "done" };
    },
  };
  const bare: ToolSet = { condition: "mcp", tools: [], call: async () => "", close: async () => {} };

  it("stops when the cost limit is reached", async () => {
    const { records, budgetStopped } = await runEval({
      fixture, tasks, conditions: ["mcp"], agent: costly, runs: 5, limits, maxCostUsd: 3, makeToolSet: async () => bare,
    });
    expect(records).toHaveLength(3);
    expect(budgetStopped).toBe(true);
  });

  it("records an agent that throws as a failure, not a crash", async () => {
    const boom: Agent = { name: "boom", run: async () => { throw new Error("gateway down"); } };
    const { records } = await runEval({ fixture, tasks: tasks.slice(0, 1), conditions: ["mcp"], agent: boom, runs: 1, limits, makeToolSet: async () => bare });
    expect(records[0]).toMatchObject({ pass: false, stoppedBy: "error" });
    expect(records[0]!.reason).toContain("gateway down");
  });

  it("never turns an unknown cost into a total", async () => {
    const unpriced: Agent = { name: "u", run: async () => ({ answer: "{}", toolCalls: 0, inputTokens: 1, outputTokens: 1, costUsd: null, ms: 1, stoppedBy: "done" }) };
    const { records } = await runEval({ fixture, tasks: tasks.slice(0, 2), conditions: ["mcp"], agent: unpriced, runs: 1, limits, makeToolSet: async () => bare });
    const s = summarize(records);
    expect(s[0]!.totalCostUsd).toBeNull();
    expect(toMarkdown(s, { agent: "u", tasks: 2, runs: 1, budgetStopped: false })).toContain("n/a (no prices given)");
  });
});

describe("raw REST tool set", () => {
  it("only reaches the documented endpoints", async () => {
    const lab = await startLab();
    try {
      const rest = await lab.makeToolSet("rest");
      const call = (args: Record<string, unknown>) => rest.call("http_request", args);
      expect(await call({ method: "GET", path: "/etc/passwd" })).toContain("ERROR");
      expect(await call({ method: "GET", path: "/api/v1/../admin" })).toContain("ERROR");
      expect(await call({ method: "POST", path: "/api/v1/conversations" })).toContain("ERROR");
      expect(await call({ method: "DELETE", path: "/api/v1/conversations" })).toContain("ERROR");
      expect(await call({ method: "GET", path: "/api/v1/dashboard/quota", query: { store_id: fixture.store.id } })).toContain("HTTP 200");
      expect(await rest.call("other_tool", {})).toContain("unknown tool");
    } finally {
      await lab.close();
    }
  });

  it("is a different tool set from the server's", () => {
    expect(restToolSet("http://x", "t").tools.map((t) => t.name)).toEqual(["http_request"]);
  });
});

describe("the model agent, against a stand-in Messages API", () => {
  interface Seen { url?: string; headers: Record<string, string | string[] | undefined>; body: any }
  let url: string;
  let seen: Seen[];
  let replies: Array<{ status?: number; json?: unknown }>;
  let http: ReturnType<typeof createHttp>;

  beforeAll(async () => {
    http = createHttp((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        seen.push({ url: req.url, headers: req.headers, body: JSON.parse(data || "{}") });
        const r = replies.shift() ?? { status: 500 };
        res.writeHead(r.status ?? 200, { "content-type": "application/json" });
        res.end(JSON.stringify(r.json ?? { error: "SECRET-KEY-ECHO" }));
      });
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => http.close(() => resolve())));

  const tool = (): ToolSet & { calls: Array<{ name: string; args: unknown }> } => {
    const calls: Array<{ name: string; args: unknown }> = [];
    return {
      condition: "mcp",
      tools: [{ name: "get_usage", description: "usage", inputSchema: { type: "object" } }],
      async call(name, args) { calls.push({ name, args }); return '{"ok":true}'; },
      close: async () => {},
      calls,
    };
  };
  const task = tasks[0]!;

  it("posts to /v1/messages once, whether the base URL ends with /v1 or not", async () => {
    for (const base of [url, `${url}/`, `${url}/v1`, `${url}/v1/`]) {
      seen = [];
      replies = [{ json: { stop_reason: "end_turn", content: [{ type: "text", text: "{}" }], usage: { input_tokens: 1, output_tokens: 1 } } }];
      await anthropicAgent({ baseUrl: base, apiKey: "k", model: "m" }).run(task, tool(), limits);
      expect(seen.map((s) => s.url)).toEqual(["/v1/messages"]);
    }
  });

  it("runs the tool loop, sends the tools, counts tokens and prices them only when told the prices", async () => {
    seen = [];
    replies = [
      { json: { stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu1", name: "get_usage", input: {} }], usage: { input_tokens: 100, output_tokens: 20 } } },
      { json: { stop_reason: "end_turn", content: [{ type: "text", text: 'Done. {"ids": ["x"]}' }], usage: { input_tokens: 150, output_tokens: 10 } } },
    ];
    const ts = tool();
    const priced = await anthropicAgent({ baseUrl: url, apiKey: "k-secret", model: "m", priceInPerMTok: 3, priceOutPerMTok: 15 }).run(task, ts, limits);
    expect(priced).toMatchObject({ stoppedBy: "done", inputTokens: 250, outputTokens: 30, answer: 'Done. {"ids": ["x"]}' });
    expect(priced.costUsd).toBeCloseTo((250 * 3 + 30 * 15) / 1e6, 10);
    expect(ts.calls).toEqual([{ name: "get_usage", args: {} }]);
    expect(seen[0]!.headers["x-api-key"]).toBe("k-secret");
    expect(seen[0]!.body.tools).toEqual([{ name: "get_usage", description: "usage", input_schema: { type: "object" } }]);
    expect(seen[1]!.body.messages.at(-1).content[0]).toMatchObject({ type: "tool_result", tool_use_id: "tu1", content: '{"ok":true}', is_error: false });

    seen = [];
    replies = [{ json: { stop_reason: "end_turn", content: [{ type: "text", text: "{}" }], usage: { input_tokens: 1, output_tokens: 1 } } }];
    const unpriced = await anthropicAgent({ baseUrl: url, apiKey: "k", model: "m" }).run(task, tool(), limits);
    expect(unpriced.costUsd).toBeNull();
  });

  it("reports an HTTP failure without echoing the response body", async () => {
    replies = [{ status: 500, json: { error: "SECRET-KEY-ECHO" } }];
    const r = await anthropicAgent({ baseUrl: url, apiKey: "k", model: "m" }).run(task, tool(), limits);
    expect(r.stoppedBy).toBe("error");
    expect(r.error).toContain("500");
    expect(JSON.stringify(r)).not.toContain("SECRET-KEY-ECHO");
  });

  it("gives up after maxTurns and says so", async () => {
    const loop = { json: { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t", name: "get_usage", input: {} }], usage: { input_tokens: 1, output_tokens: 1 } } };
    replies = [loop, loop, loop];
    const r = await anthropicAgent({ baseUrl: url, apiKey: "k", model: "m" }).run(task, tool(), { maxTurns: 3 });
    expect(r).toMatchObject({ stoppedBy: "turns" });
  });
});
