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
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function embedTexts(
  inputs: string[],
  inputType: InputType = "document"
): Promise<number[][]> {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) throw new Error("Missing VOYAGE_API_KEY environment variable");
  if (inputs.length === 0) return [];

  // Retry on rate limits (429) and transient server errors (5xx) with backoff.
  // Voyage's free trial caps at 3 requests/min; a payment method lifts this.
  const maxAttempts = 4;
  let delayMs = 2000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(VOYAGE_EMBEDDINGS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: MODEL, input: inputs, input_type: inputType }),
    });

    if (res.ok) {
      const data = (await res.json()) as {
        data: { embedding: number[]; index: number }[];
      };
      return data.data
        .slice()
        .sort((a, b) => a.index - b.index)
        .map((d) => d.embedding);
    }

    if ((res.status === 429 || res.status >= 500) && attempt < maxAttempts) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : delayMs;
      await sleep(wait);
      delayMs *= 2;
      continue;
    }

    const t = await res.text().catch(() => "");
    throw new Error(`Voyage embeddings failed (${res.status}): ${t}`);
  }

  throw new Error("Voyage embeddings failed after retries");
}

/** Embed a single string. Defaults to "query" since this is used for search. */
export async function embedText(
  input: string,
  inputType: InputType = "query"
): Promise<number[]> {
  const [vector] = await embedTexts([input], inputType);
  return vector;
}
