import { retrieve, listArticleIndex, RetrievedChunk } from "@/lib/retrieval";

const QA_SYSTEM_PROMPT =
  "You are ARIA, a research assistant for Activant Capital. Answer content questions using ONLY the provided research excerpts; if they don't contain the answer, say you don't have that in the research rather than guessing. You are also given an index of EVERY research article with its publication date, sorted newest first — use the index (not the excerpts) to answer questions about recency, dates, counts, or which articles exist (e.g. 'what's the latest article', 'how many did we publish in 2025'). Article dates are month-level precision. Be concise and write for a Slack message. Attribute key facts to the article they came from. Use Slack formatting: single asterisks for *bold*, never double asterisks, and no markdown headers.";

const MONTH_NAMES = [
  "", "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function formatMonth(d: string | null): string {
  if (!d) return "date unknown";
  const [y, m] = d.split("-");
  const idx = Number(m);
  return idx >= 1 && idx <= 12 ? `${MONTH_NAMES[idx]} ${y}` : y;
}

/** Answer a question grounded in the research library. Returns Slack-ready text. */
export async function answerQuestion(question: string): Promise<string> {
  const q = (question || "").trim();
  if (!q) {
    return "Ask me a question about Activant's research and I'll dig through it.";
  }

  // Pull the dated article index (for recency/listing) and the most relevant
  // excerpts (for content) in parallel.
  const [indexResult, chunkResult] = await Promise.allSettled([
    listArticleIndex(),
    retrieve(q, 6),
  ]);

  const index = indexResult.status === "fulfilled" ? indexResult.value : [];
  const chunks: RetrievedChunk[] =
    chunkResult.status === "fulfilled" ? chunkResult.value : [];
  if (chunkResult.status === "rejected") {
    console.error("Retrieval failed:", chunkResult.reason);
  }

  if (chunks.length === 0 && index.length === 0) {
    return "I couldn't find anything in the research library for that.";
  }

  const indexText = index
    .map(
      (a) =>
        `- ${a.article_title} — ${formatMonth(a.published_at)}${a.article_url ? ` (${a.article_url})` : ""}`
    )
    .join("\n");

  const context = chunks
    .map(
      (c, i) =>
        `[[${i + 1}]] ${c.article_title}${c.article_url ? ` (${c.article_url})` : ""}\n${c.content}`
    )
    .join("\n\n---\n\n");

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY environment variable");
  const model = process.env.QA_MODEL?.trim() || "anthropic/claude-sonnet-4-5";

  const userContent =
    `Article index (all research, newest first):\n${indexText || "(none)"}\n\n` +
    `---\n\nResearch excerpts:\n${context || "(none)"}\n\n` +
    `---\n\nQuestion: ${q}`;

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
        { role: "user", content: userContent },
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

  // Append up to 3 distinct source links from the excerpts used.
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

/**
 * $joke — a single-line joke riffing on a random article from the research
 * embedding library. Returns exactly one line.
 */
export async function researchJoke(): Promise<string> {
  let topic = "tech and growth-equity research";
  try {
    const index = await listArticleIndex();
    if (index.length) {
      topic = index[Math.floor(Math.random() * index.length)].article_title || topic;
    }
  } catch {
    // fall back to the generic topic
  }

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
        {
          role: "system",
          content:
            "You tell ONE clever, clean, workplace-appropriate one-liner joke or pun. Output exactly one line — no preamble, no explanation, no follow-up line, no quotation marks.",
        },
        { role: "user", content: `Give me a one-liner joke riffing on this research topic: "${topic}".` },
      ],
    }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`OpenRouter request failed (${res.status}): ${t}`);
  }

  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const joke = data.choices?.[0]?.message?.content?.trim();
  if (!joke) throw new Error("OpenRouter returned an empty joke");

  // Enforce a single line no matter what the model returns.
  return joke.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] ?? joke;
}
