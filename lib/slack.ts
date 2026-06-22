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
): Promise<string | null> {
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

  const data = (await res.json()) as { ok: boolean; ts?: string; error?: string };
  if (!data.ok) {
    throw new Error(`Slack chat.postMessage failed: ${data.error ?? "unknown_error"}`);
  }
  return data.ts ?? null;
}

/**
 * Edit an existing message (chat.update). Used to replace a "working…"
 * placeholder with the final answer so long tasks show progress in one message.
 */
export async function updateSlackMessage(
  channel: string,
  ts: string,
  text: string
): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("Missing SLACK_BOT_TOKEN environment variable");

  const res = await fetch(`${SLACK_API}/chat.update`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel, ts, text }),
  });

  const data = (await res.json()) as { ok: boolean; error?: string };
  if (!data.ok) {
    throw new Error(`Slack chat.update failed: ${data.error ?? "unknown_error"}`);
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
 * "user". The bot mention and a leading "$aff" are stripped from user turns.
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
    if (!isBot) content = content.replace(/^\$aff\b/i, "").trim();
    if (!content) continue;
    out.push({ role: isBot ? "assistant" : "user", content });
  }
  return out;
}

/**
 * Fetch recent conversation messages (via conversations.history) as role-tagged
 * turns, filtered to the ARIA conversation only: bot messages, plus user messages
 * that mention the bot or start with "$aff". This gives multi-turn context when
 * replying flat (not in a thread) without pulling in unrelated channel chatter.
 * Returns chronological order (oldest first). Requires the matching history scope.
 */
/**
 * Raw text of a thread's root (parent) message. Used to detect whether a thread
 * was started with a $aff command so follow-ups can stay in Affinity mode.
 */
export async function getThreadRootText(channel: string, threadTs: string): Promise<string> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("Missing SLACK_BOT_TOKEN environment variable");

  const params = new URLSearchParams({ channel, ts: threadTs, limit: "1" });
  const res = await fetch(`${SLACK_API}/conversations.replies?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = (await res.json()) as {
    ok: boolean;
    error?: string;
    messages?: { text?: string }[];
  };
  if (!data.ok) {
    throw new Error(`Slack conversations.replies failed: ${data.error ?? "unknown_error"}`);
  }
  return data.messages?.[0]?.text ?? "";
}

export async function getRecentMessages(
  channel: string,
  botUserId: string,
  limit = 12
): Promise<ThreadMessage[]> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("Missing SLACK_BOT_TOKEN environment variable");

  // Over-fetch since filtering drops unrelated messages.
  const params = new URLSearchParams({ channel, limit: String(Math.max(limit * 3, 30)) });
  const res = await fetch(`${SLACK_API}/conversations.history?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = (await res.json()) as {
    ok: boolean;
    error?: string;
    messages?: { user?: string; bot_id?: string; text?: string; subtype?: string }[];
  };
  if (!data.ok) {
    throw new Error(`Slack conversations.history failed: ${data.error ?? "unknown_error"}`);
  }

  const mentionRe = new RegExp(`<@${botUserId}>`, "g");
  const collected: ThreadMessage[] = [];
  // conversations.history returns newest-first.
  for (const m of data.messages ?? []) {
    if (m.subtype && m.subtype !== "bot_message") continue;
    const isBot = !!m.bot_id || m.user === botUserId;
    const raw = m.text ?? "";
    const isAffinityUserMsg =
      !isBot && (raw.includes(`<@${botUserId}>`) || /^\s*\$aff\b/i.test(raw));
    if (!isBot && !isAffinityUserMsg) continue; // drop unrelated chatter
    let content = raw.replace(mentionRe, "").trim();
    if (!isBot) content = content.replace(/^\$aff\b/i, "").trim();
    if (!content) continue;
    collected.push({ role: isBot ? "assistant" : "user", content });
  }
  collected.reverse(); // chronological
  return collected.slice(-limit);
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
