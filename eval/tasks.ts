import type { Fixture } from "../conformance/fake-api.js";
import type { Task } from "./types.js";

// Ground truth is derived from the conformance fixture, so a task cannot drift
// from the data it is asked about. The store is synthetic ("Sandbox Hotel").
export function buildTasks(fx: Fixture): Task[] {
  const own = fx.conversations.filter((c) => c.store_id === fx.store.id);
  const [c1, c2] = own;
  if (!c1 || !c2) throw new Error("fixture needs two conversations in the store");
  const other = fx.conversations.find((c) => c.store_id === fx.otherStore.id)!;
  const pending = own.filter((c) => c.handover_status === "pending").map((c) => c.id);
  const unread = own.filter((c) => c.status === "unread").map((c) => c.id);
  const failed = fx.toolLogs.find((l) => l.store_id === fx.store.id && l.conversation_id === c1.id && l.error_type && l.error_type !== "success");
  if (!failed) throw new Error("fixture needs a failed tool call in the first conversation");
  const q = fx.quota;
  const store = `Your store id is ${fx.store.id}.`;
  const json = (shape: string) => ` Finish with one JSON object ${shape} and nothing after it.`;

  return [
    { id: "waiting-for-human", category: "triage", expect: { kind: "ids", ids: pending },
      prompt: `${store} Which conversations are waiting for a human agent (handover pending)?${json('{"ids": ["<conversation id>", ...]}')}` },
    { id: "unread-conversations", category: "triage", expect: { kind: "ids", ids: unread },
      prompt: `${store} Which conversations have not been read yet by the store's agents?${json('{"ids": [...]}')}` },
    { id: "why-bot-did-not-answer", category: "diagnosis", expect: { kind: "mentions", field: "reason", all: ["get_room_types", "tool_error"] },
      prompt: `${store} In conversation ${c1.id} the bot did not answer the customer's room-type question. Which of the store's tools failed, and what response source did the bot's reply carry?${json('{"reason": "<one sentence naming the tool and the response source>"}')}` },
    { id: "price-quoted", category: "diagnosis", expect: { kind: "mentions", field: "price", all: ["4.015.000"] },
      prompt: `${store} In conversation ${c2.id} what total price did the bot quote the customer?${json('{"price": "<the amount as written>"}')}` },
    { id: "price-source", category: "diagnosis", expect: { kind: "fields", fields: { document: "Harga Kamar" } },
      prompt: `${store} In conversation ${c2.id}, which knowledge-base document did the bot's price answer come from?${json('{"document": "<title>"}')}` },
    { id: "bot-confidence", category: "diagnosis", expect: { kind: "fields", fields: { confidence: 88.1 } },
      prompt: `${store} What confidence score did the bot's reply carry in conversation ${c2.id}?${json('{"confidence": <number>}')}` },
    { id: "kb-coverage", category: "knowledge", expect: { kind: "mentions", field: "answer", all: ["14.00"] },
      prompt: `${store} Does the store's knowledge base say what time check-in starts? If so, at what time?${json('{"answer": "<the time as written in the knowledge base>"}')}` },
    { id: "failed-tool-calls", category: "diagnosis", expect: { kind: "fields", fields: { tool: failed.tool_name, http_status: failed.response_status } },
      prompt: `${store} Which tool call failed in conversation ${c1.id}, and what HTTP status code did the failed call get?${json('{"tool": "<tool name>", "http_status": <number>}')}` },
    { id: "whatsapp-usage", category: "usage", expect: { kind: "fields", fields: { used: q.whatsapp_conversations_used, limit: q.whatsapp_conversations_limit } },
      prompt: `${store} For the current billing period, how many WhatsApp conversations has the store used, and what is its limit?${json('{"used": <number>, "limit": <number>}')}` },
    { id: "ai-tokens-billed", category: "usage", expect: { kind: "fields", fields: { billed: q.ai_tokens_billed } },
      prompt: `${store} How many AI tokens has the store been billed for in the current period?${json('{"billed": <number>}')}` },
    { id: "other-store-conversation", category: "isolation", expect: { kind: "not_found" },
      prompt: `${store} Read conversation ${other.id} and tell me what the customer wrote. If you cannot read it, say so.${json('{"found": <true|false>, "text": "<what the customer wrote, or empty>"}')}` },
  ];
}
