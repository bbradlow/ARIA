const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

const SYSTEM_PROMPT =
  "You are a research analyst assistant. Given the full text of a research article, " +
  "produce a concise 3-5 sentence executive summary suitable for a Slack DM to a team " +
  "of investors. Highlight the core thesis, key data points, and takeaway.";

/**
 * Summarizes an article's body text via OpenRouter (Claude Sonnet 4.5).
 * Throws on HTTP errors or malformed responses so the caller can skip the
 * article and continue the run.
 */
export async function summarizeArticle(bodyText: string): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY environment variable");

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      // Optional attribution headers for OpenRouter's dashboard / rankings.
      "HTTP-Referer": "https://activantcapital.com",
      "X-Title": "Activant Research Bot",
    },
    body: JSON.stringify({
      model: "anthropic/claude-sonnet-4-5",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: bodyText },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`OpenRouter request failed: ${res.status} ${errText}`);
  }

  const data = await res.json();
  const summary = data?.choices?.[0]?.message?.content;
  if (!summary || typeof summary !== "string") {
    throw new Error("OpenRouter returned no summary content");
  }
  return summary.trim();
}
