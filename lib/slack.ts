import crypto from "crypto";

const SLACK_API = "https://slack.com/api";

/**
 * Send a Slack DM via chat.postMessage.
 *
 * `channel` may be a user ID (e.g. "U0123") — Slack resolves it to that user's
 * DM channel automatically — or a DM channel ID (e.g. "D0123").
 *
 * Note: Slack's Web API returns HTTP 200 even for failures; the real status is
 * in the JSON body's `ok` field, so we inspect that and throw on failure.
 */
export async function sendSlackDM(channel: string, text: string): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("Missing SLACK_BOT_TOKEN environment variable");

  const res = await fetch(`${SLACK_API}/chat.postMessage`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel, text }),
  });

  const data = (await res.json()) as { ok: boolean; error?: string };
  if (!data.ok) {
    throw new Error(
      `Slack chat.postMessage failed: ${data.error ?? "unknown_error"}`
    );
  }
}

/**
 * Verify an inbound Slack request using HMAC-SHA256.
 *
 * Slack signs each request as `v0=<hmac>` over the string
 * `v0:<timestamp>:<raw_body>` keyed by the app's signing secret. We also reject
 * requests with a timestamp older than 5 minutes to mitigate replay attacks.
 *
 * IMPORTANT: `rawBody` must be the exact, unparsed request body string.
 */
export function verifySlackSignature(
  rawBody: string,
  timestamp: string | null,
  signature: string | null
): boolean {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret || !timestamp || !signature) return false;

  // Replay protection: reject anything older than five minutes.
  const FIVE_MINUTES = 60 * 5;
  const now = Math.floor(Date.now() / 1000);
  const ts = parseInt(timestamp, 10);
  if (Number.isNaN(ts) || Math.abs(now - ts) > FIVE_MINUTES) return false;

  const base = `v0:${timestamp}:${rawBody}`;
  const hmac = crypto
    .createHmac("sha256", signingSecret)
    .update(base)
    .digest("hex");
  const expected = `v0=${hmac}`;

  // Constant-time comparison to avoid timing leaks.
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
