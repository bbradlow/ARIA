import { ThreadMessage } from "@/lib/slack";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";
const AFFINITY_MCP_URL = "https://mcp.affinity.co/mcp";
const SERVER_NAME = "affinity";
// Current MCP connector beta (the 2025-04-04 header is deprecated).
const MCP_BETA = "mcp-client-2025-11-20";

const SYSTEM_PROMPT =
  "You are ARIA, a CRM intelligence assistant for Activant Capital. You have live " +
  "access to Activant's deal pipeline, contacts, organizations, and relationship data " +
  "through the Affinity MCP tools. Answer questions about the pipeline, companies, " +
  "people, and deals by querying Affinity rather than guessing. Be concise and write " +
  "for a Slack message: use single asterisks for *bold*, never double asterisks, and no " +
  "markdown headers. When you reference a record, include the most useful identifying " +
  "details (name, stage, owner, last activity). If Affinity returns nothing relevant, " +
  "say so plainly.";

// Anthropic requires messages to start with a user turn and alternate roles, so
// drop leading assistant turns and merge consecutive same-role turns.
function normalize(messages: ThreadMessage[]): ThreadMessage[] {
  const trimmed = [...messages];
  while (trimmed.length && trimmed[0].role === "assistant") trimmed.shift();

  const merged: ThreadMessage[] = [];
  for (const m of trimmed) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content += `\n\n${m.content}`;
    else merged.push({ role: m.role, content: m.content });
  }
  return merged;
}

/**
 * Answer a CRM question by calling Claude with the Affinity MCP server attached.
 * `history` is the full thread (ending with the current question) for multi-turn.
 */
export async function askAffinity(history: ThreadMessage[]): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY environment variable");

  const messages = normalize(history);
  if (messages.length === 0) {
    return "Ask me about the pipeline — e.g. `@ARIA /aff which deals are in diligence?`";
  }

  const server: Record<string, unknown> = {
    type: "url",
    url: AFFINITY_MCP_URL,
    name: SERVER_NAME,
  };
  if (process.env.AFFINITY_MCP_TOKEN) {
    server.authorization_token = process.env.AFFINITY_MCP_TOKEN;
  }

  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": MCP_BETA,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages,
      mcp_servers: [server],
      tools: [{ type: "mcp_toolset", mcp_server_name: SERVER_NAME }],
    }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Anthropic request failed (${res.status}): ${t}`);
  }

  const data = (await res.json()) as {
    content?: { type: string; text?: string }[];
  };

  // The final answer is the concatenation of text blocks; mcp_tool_use /
  // mcp_tool_result blocks are intermediate and can be ignored here.
  const text = (data.content ?? [])
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text as string)
    .join("\n")
    .trim();

  return text || "I didn't get a usable answer back from Affinity.";
}
