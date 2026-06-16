import crypto from "crypto";

const SLACK_API = "https://slack.com/api";

/**
 * Post a message via chat.postMessage. `channel` may be a user ID (Slack opens
 * the DM automatically), a DM channel ID, or a public/private channel ID the
 * bot is a member of.
 *
 * Slack's Web API returns HTTP 200 even on failure; the real status is the
 * JSON body's `ok` field, so we inspect that and throw on failure.
 */
export async function postSlackMessage(
  channel: string,
  text: string,
  threadTs?: string
): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("Missing SLACK_BOT_TOKEN environment variable");

  const res = await fetch(`${SLACK_API}/chat.postMessage`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel, text, ...(threadTs ? { thread_ts: threadTs } : {}) }),
  });

  const data = (await res.json()) as { ok: boolean; error?: string };
  if (!data.ok) {
    throw new Error(`Slack chat.postMessage failed: ${data.error ?? "unknown_error"}`);
  }
}

// Cache the bot's own user id across warm invocations to avoid repeat lookups.
let cachedBotUserId: string | null = null;

/**
 * Resolve the bot's own Slack user ID (via auth.test). Used to tell whether a
 * member_joined_channel / member_left_channel event refers to the bot itself.
 */
export async function getBotUserId(): Promise<string> {
  if (cachedBotUserId) return cachedBotUserId;
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("Missing SLACK_BOT_TOKEN environment variable");

  const res = await fetch(`${SLACK_API}/auth.test`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = (await res.json()) as { ok: boolean; user_id?: string; error?: string };
  if (!data.ok || !data.user_id) {
    throw new Error(`Slack auth.test failed: ${data.error ?? "unknown_error"}`);
  }
  cachedBotUserId = data.user_id;
  return cachedBotUserId;
}

export interface ThreadMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Fetch a thread's messages (via conversations.replies) as role-tagged turns
 * for multi-turn LLM context. Bot messages become "assistant", everyone else
 * "user". The bot mention and a leading "/aff" are stripped from user turns.
 * Requires the matching history scope for the conversation type
 * (channels:history / groups:history / im:history / mpim:history).
 */
export async function getThreadMessages(
  channel: string,
  threadTs: string,
  botUserId: string
): Promise<ThreadMessage[]> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("Missing SLACK_BOT_TOKEN environment variable");

  const params = new URLSearchParams({ channel, ts: threadTs, limit: "50" });
  const res = await fetch(`${SLACK_API}/conversations.replies?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = (await res.json()) as {
    ok: boolean;
    error?: string;
    messages?: { user?: string; bot_id?: string; text?: string; subtype?: string }[];
  };
  if (!data.ok) {
    throw new Error(`Slack conversations.replies failed: ${data.error ?? "unknown_error"}`);
  }

  const mentionRe = new RegExp(`<@${botUserId}>`, "g");
  const out: ThreadMessage[] = [];
  for (const m of data.messages ?? []) {
    if (m.subtype && m.subtype !== "bot_message") continue; // skip joins/system
    const isBot = !!m.bot_id || m.user === botUserId;
    let content = (m.text ?? "").replace(mentionRe, "").trim();
    if (!isBot) content = content.replace(/^\/aff\b/i, "").trim();
    if (!content) continue;
    out.push({ role: isBot ? "assistant" : "user", content });
  }
  return out;
}

/**
 * Verify an inbound Slack request using HMAC-SHA256 over `v0:<ts>:<rawBody>`,
 * plus a 5-minute timestamp window for replay protection. `rawBody` must be the
 * exact, unparsed request body string.
 */
export function verifySlackSignature(
  rawBody: string,
  timestamp: string | null,
  signature: string | null
): boolean {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret || !timestamp || !signature) return false;

  const FIVE_MINUTES = 60 * 5;
  const now = Math.floor(Date.now() / 1000);
  const ts = parseInt(timestamp, 10);
  if (Number.isNaN(ts) || Math.abs(now - ts) > FIVE_MINUTES) return false;

  const base = `v0:${timestamp}:${rawBody}`;
  const hmac = crypto.createHmac("sha256", signingSecret).update(base).digest("hex");
  const expected = `v0=${hmac}`;

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
