// The embedding call, the same one the production API makes: OpenAI's /v1/embeddings,
// one text in, one 1536-wide vector out. ada-002 and text-embedding-3-small are both
// 1536-wide, so the width cannot tell them apart: the model name is kept next to the
// stored vectors (sandbox.meta) and checked before every search.

export const EMBEDDING_DIM = 1536;

export interface EmbedderConfig {
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
}

export function openAiEmbedder(cfg: EmbedderConfig): (text: string) => Promise<number[]> {
  const f = cfg.fetch ?? fetch;
  return async (text) => {
    const res = await f("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ model: cfg.model, input: text }),
    });
    // The body is not echoed: an error body can repeat the key.
    if (!res.ok) throw new Error(`the embedding endpoint answered HTTP ${res.status}`);
    const body = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
    const v = body.data?.[0]?.embedding;
    if (!v || v.length !== EMBEDDING_DIM) throw new Error(`the embedding has ${v?.length ?? 0} dimensions, expected ${EMBEDDING_DIM}`);
    return v;
  };
}
