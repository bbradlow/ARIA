const VOYAGE_EMBEDDINGS_URL = "https://api.voyageai.com/v1/embeddings";
// voyage-finance-2 is a finance-domain model returning 1024-dim vectors — this
// MUST match the vector(1024) column in the research_chunks table.
const MODEL = "voyage-finance-2";

type InputType = "document" | "query";

/**
 * Embed a batch of texts in a single request. Returns vectors in input order.
 * Use inputType "document" when storing content and "query" when searching —
 * Voyage tailors the vector to the task, which improves retrieval.
 */
export async function embedTexts(
  inputs: string[],
  inputType: InputType = "document"
): Promise<number[][]> {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) throw new Error("Missing VOYAGE_API_KEY environment variable");
  if (inputs.length === 0) return [];

  const res = await fetch(VOYAGE_EMBEDDINGS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: MODEL, input: inputs, input_type: inputType }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Voyage embeddings failed (${res.status}): ${t}`);
  }

  const data = (await res.json()) as {
    data: { embedding: number[]; index: number }[];
  };
  return data.data
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}

/** Embed a single string. Defaults to "query" since this is used for search. */
export async function embedText(
  input: string,
  inputType: InputType = "query"
): Promise<number[]> {
  const [vector] = await embedTexts([input], inputType);
  return vector;
}
