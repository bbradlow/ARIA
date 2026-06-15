import { retrieve, RetrievedChunk } from "@/lib/retrieval";

const QA_SYSTEM_PROMPT =
  "You are ARIA, a research assistant for Activant Capital. Answer the user's question using ONLY the provided research excerpts. Be concise and specific, and write for a Slack message. If the excerpts do not contain the answer, say you don't have that in the research rather than guessing. Attribute key facts to the article they came from. Use Slack formatting: single asterisks for *bold*, never double asterisks, and no markdown headers.";

/** Answer a question grounded in the research library. Returns Slack-ready text. */
export async function answerQuestion(question: string): Promise<string> {
  const q = (question || "").trim();
  if (!q) {
    return "Ask me a question about Activant's research and I'll dig through it.";
  }

  let chunks: RetrievedChunk[];
  try {
    chunks = await retrieve(q, 6);
  } catch (err) {
    console.error("Retrieval failed:", err);
    return "Sorry — I hit an error searching the research library.";
  }

  if (chunks.length === 0) {
    return "I couldn't find anything relevant in the research library for that.";
  }

  const context = chunks
    .map(
      (c, i) =>
        `[[${i + 1}]] ${c.article_title}${c.article_url ? ` (${c.article_url})` : ""}\n${c.content}`
    )
    .join("\n\n---\n\n");

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY environment variable");
  const model = process.env.QA_MODEL?.trim() || "anthropic/claude-sonnet-4-5";

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://activantcapital.com",
      "X-Title": "Activant Research Bot",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: QA_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Research excerpts:\n\n${context}\n\n---\n\nQuestion: ${q}`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`OpenRouter request failed (${res.status}): ${t}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const answer = data.choices?.[0]?.message?.content?.trim();
  if (!answer) throw new Error("OpenRouter returned an empty answer");

  // Append up to 3 distinct source links.
  const sources = [
    ...new Map(
      chunks.filter((c) => c.article_url).map((c) => [c.article_url, c])
    ).values(),
  ].slice(0, 3);

  if (sources.length === 0) return answer;
  const links = sources
    .map((s) => `• <${s.article_url}|${s.article_title}>`)
    .join("\n");
  return `${answer}\n\n*Sources:*\n${links}`;
}
