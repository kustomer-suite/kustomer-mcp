import { mcpProbe, restProbe, type Probe } from "../probe.js";
import type { Agent, AgentResult, Task, ToolSet } from "../types.js";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

// Not a model: a fixed program that solves each task through the tool set it is
// given. It proves two things the evaluation depends on: every task is solvable
// in both conditions, and the graders accept a correct answer. It says nothing
// about how well a model does.
export function oracleAgent(storeId: string): Agent {
  return {
    name: "oracle",
    async run(task: Task, tools: ToolSet): Promise<AgentResult> {
      const start = Date.now();
      const probe: Probe = tools.condition === "mcp" ? mcpProbe(tools) : restProbe(tools, storeId);
      const answer = JSON.stringify(await solve(task, probe, storeId));
      return { answer, toolCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, ms: Date.now() - start, stoppedBy: "done" };
    },
  };
}

// The conversation a task asks about is the first id in its prompt that is not the store id.
function conversationOf(prompt: string, storeId: string): string {
  return (prompt.match(UUID) ?? []).find((id) => id !== storeId) ?? "";
}

async function solve(task: Task, p: Probe, storeId: string): Promise<Record<string, unknown>> {
  const conv = conversationOf(task.prompt, storeId);
  const botReply = async () => (await p.conversation(conv)).messages.find((m) => m.author === "bot" && (m.responseSource || m.confidence !== undefined));
  switch (task.id) {
    case "waiting-for-human":
      return { ids: await p.pending() };
    case "unread-conversations":
      return { ids: await p.unread() };
    case "why-bot-did-not-answer": {
      const failed = (await p.failedToolCalls(conv))[0];
      return { reason: `${failed?.tool} failed; the bot's reply carried response source ${(await botReply())?.responseSource}` };
    }
    case "price-quoted":
      return { price: (await p.conversation(conv)).messages.map((m) => m.text.match(/Rp\s?[\d.]+/)?.[0]).find(Boolean) };
    case "price-source":
      return { document: (await botReply())?.titles?.[0] };
    case "bot-confidence":
      return { confidence: (await botReply())?.confidence };
    case "kb-coverage":
      return { answer: (await p.search("check-in")).join(" ").match(/\b\d{1,2}\.\d{2}\b/)?.[0] };
    case "failed-tool-calls": {
      const f = (await p.failedToolCalls(conv))[0];
      return { tool: f?.tool, http_status: f?.status };
    }
    case "whatsapp-usage": {
      const u = await p.usage();
      return { used: u.whatsappUsed, limit: u.whatsappLimit };
    }
    case "ai-tokens-billed":
      return { billed: (await p.usage()).billed };
    case "other-store-conversation": {
      const c = await p.conversation(conv);
      return { found: c.found, text: c.found ? c.messages[0]?.text : "" };
    }
  }
  throw new Error(`oracle has no program for task ${task.id}`);
}

// A control: an agent that always answers wrongly, to show the graders reject.
export const wrongAgent: Agent = {
  name: "wrong",
  async run(): Promise<AgentResult> {
    return { answer: '{"ids": [], "found": true, "reason": "unknown"}', toolCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, ms: 0, stoppedBy: "done" };
  },
};
