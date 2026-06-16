import { ThreadMessage } from "@/lib/slack";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";
const AFFINITY_MCP_URL = "https://mcp.affinity.co/mcp";
const SERVER_NAME = "affinity";
// Current MCP connector beta (the 2025-04-04 header is deprecated).
const MCP_BETA = "mcp-client-2025-11-20";
// Abort the Anthropic call before the function's maxDuration. Keep this a few
// seconds under the events route maxDuration. Default 55s suits the Hobby 60s
// cap; raise via AFFINITY_TIMEOUT_MS if you move to a plan with a higher limit.
const TIMEOUT_MS = Number(process.env.AFFINITY_TIMEOUT_MS) || 55000;

// Write-enabled by default. Set AFFINITY_READ_ONLY=true to restrict ARIA to
// read/list/search tools (and have it decline edits).
const READ_ONLY = process.env.AFFINITY_READ_ONLY === "true";

// After running `$aff what tools do you have?`, paste the read/list/search/get
// tool names here. When READ_ONLY is on AND this list is non-empty, ONLY these
// tools are exposed to Claude — a hard block on writes at the connector layer.
// Leave empty to rely on the read-only system instruction + Affinity scope.
const READ_TOOLS: string[] = [
  // "affinity_search",
  // "affinity_get_company",
  // "affinity_list_opportunities",
];

const BASE_PROMPT =
  "You are ARIA, a CRM intelligence assistant for Activant Capital. You have live " +
  "access to Activant's deal pipeline, contacts, organizations, and relationship data " +
  "through the Affinity MCP tools. Answer questions about the pipeline, companies, " +
  "people, and deals by querying Affinity rather than guessing. Work efficiently: to find " +
  "a specific company, person, or deal, search or look it up directly by name — do NOT " +
  "list or page through entire lists or the full pipeline, which is slow and may time out. " +
  "Make the fewest, most targeted tool calls needed; if a couple of targeted searches " +
  "don't find it, say so rather than enumerating large datasets. When creating or " +
  "updating a record, resolve the target with a single targeted search, then make the " +
  "change in as few calls as possible and do not re-read or re-confirm it afterward " +
  "unless asked. Be concise and write " +
  "for a Slack message: use single asterisks for *bold*, never double asterisks, and no " +
  "markdown headers. When you reference a record, include the most useful identifying " +
  "details (name, stage, owner, last activity). If Affinity returns nothing relevant, " +
  "say so plainly.";

const READ_ONLY_CLAUSE =
  " IMPORTANT: You are in READ-ONLY mode. Only use tools that retrieve, list, search, " +
  "or read data. Never call any tool that creates, updates, deletes, or otherwise " +
  "modifies Affinity data. If asked to change something, explain that you are currently " +
  "read-only and cannot make edits.";

function systemPrompt(): string {
  return READ_ONLY ? BASE_PROMPT + READ_ONLY_CLAUSE : BASE_PROMPT;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
    return "Ask me about the pipeline — e.g. `@ARIA $aff which deals are in diligence?`";
  }

  const server: Record<string, unknown> = {
    type: "url",
    url: AFFINITY_MCP_URL,
    name: SERVER_NAME,
  };
  if (process.env.AFFINITY_MCP_TOKEN) {
    server.authorization_token = process.env.AFFINITY_MCP_TOKEN;
  }
  // When read-only and an explicit read-tool allowlist is configured, restrict
  // the connector to those tools so write tools are never callable.
  if (READ_ONLY && READ_TOOLS.length > 0) {
    server.tool_configuration = { enabled: true, allowed_tools: READ_TOOLS };
  }

  const requestBody = JSON.stringify({
    model: MODEL,
    max_tokens: 2000,
    system: systemPrompt(),
    messages,
    mcp_servers: [server],
    tools: [{ type: "mcp_toolset", mcp_server_name: SERVER_NAME }],
  });

  // Retry transient Anthropic 5xx / network errors (they return fast, so this
  // stays within the function budget). Timeouts are NOT retried.
  const maxAttempts = 3;
  let lastError = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": MCP_BETA,
          "content-type": "application/json",
        },
        body: requestBody,
        signal: controller.signal,
      });

      if (res.ok) {
        const data = (await res.json()) as {
          content?: { type: string; text?: string }[];
        };
        const text = (data.content ?? [])
          .filter((b) => b.type === "text" && b.text)
          .map((b) => b.text as string)
          .join("\n")
          .trim();
        return text || "I didn't get a usable answer back from Affinity.";
      }

      const t = await res.text().catch(() => "");
      lastError = `Anthropic request failed (${res.status}): ${t}`;
      // A 500 here usually means the MCP connector couldn't reach/authenticate
      // the Affinity server. Retry in case it's transient.
      if (res.status >= 500 && attempt < maxAttempts) {
        await sleep(1500 * attempt);
        continue;
      }
      throw new Error(lastError);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(
          "Affinity request timed out — the query needed too many or too-large tool calls. Try a more specific question."
        );
      }
      if (attempt < maxAttempts) {
        lastError = err instanceof Error ? err.message : String(err);
        await sleep(1500 * attempt);
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(lastError || "Anthropic request failed after retries");
}
