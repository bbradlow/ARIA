import { NextRequest } from "next/server";
import crypto from "crypto";
import { waitUntil } from "@vercel/functions";
import { AppwriteException } from "node-appwrite";
import { appwrite } from "@/lib/appwrite";
import { postSlackMessage } from "@/lib/slack";

// Node runtime is required: we use the `crypto` module for signature
// verification, and the Edge runtime doesn't provide it.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUBSCRIBE_REPLY =
  "✅ You're subscribed! You'll receive a DM summary every time a new research article is published on activantcapital.com.";
const UNSUBSCRIBE_REPLY =
  "👋 You've been unsubscribed and won't receive any more research alerts.";
const HELP_REPLY =
  "👋 Hi! I send summaries of new Activant Capital research articles directly to you.\n" +
  "• Type `subscribe` to start receiving alerts.\n" +
  "• Type `unsubscribe` to stop.";

/**
 * Verifies the request genuinely came from Slack using HMAC-SHA256 over
 * `v0:{timestamp}:{rawBody}`, compared in constant time. Also rejects stale
 * timestamps (>5 min) to mitigate replay attacks.
 */
function verifySlackSignature(
  rawBody: string,
  signature: string | null,
  timestamp: string | null,
): boolean {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret || !signature || !timestamp) return false;

  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(Number(timestamp))) return false;
  if (Math.abs(now - Number(timestamp)) > 60 * 5) return false;

  const base = `v0:${timestamp}:${rawBody}`;
  const computed =
    "v0=" +
    crypto.createHmac("sha256", signingSecret).update(base).digest("hex");

  const a = Buffer.from(computed);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Runs after we've already ack'd Slack with a 200. Performs the DB write and
 * sends the reply DM. Errors are logged, never thrown (nothing is awaiting it).
 */
async function handleCommand(slackUserId: string, text: string): Promise<void> {
  const normalized = text.trim().toLowerCase();

  try {
    const { databases, databaseId, subscribersCollectionId } = appwrite();

    if (normalized === "subscribe") {
      // The Slack user ID is the document ID, so a repeat subscribe throws a
      // 409 (document already exists) — which we treat as "already subscribed".
      try {
        await databases.createDocument({
          databaseId,
          collectionId: subscribersCollectionId,
          documentId: slackUserId,
          data: { slack_user_id: slackUserId },
        });
      } catch (err) {
        if (!(err instanceof AppwriteException && err.code === 409)) throw err;
      }
      await postSlackMessage(slackUserId, SUBSCRIBE_REPLY);
    } else if (normalized === "unsubscribe") {
      // A 404 means they weren't subscribed — also fine (idempotent).
      try {
        await databases.deleteDocument({
          databaseId,
          collectionId: subscribersCollectionId,
          documentId: slackUserId,
        });
      } catch (err) {
        if (!(err instanceof AppwriteException && err.code === 404)) throw err;
      }
      await postSlackMessage(slackUserId, UNSUBSCRIBE_REPLY);
    } else {
      await postSlackMessage(slackUserId, HELP_REPLY);
    }
  } catch (err) {
    console.error("Failed to handle command", { slackUserId, normalized, err });
  }
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const signature = req.headers.get("x-slack-signature");
  const timestamp = req.headers.get("x-slack-request-timestamp");

  if (!verifySlackSignature(rawBody, signature, timestamp)) {
    return new Response("invalid signature", { status: 403 });
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("bad request", { status: 400 });
  }

  // 1. URL verification handshake (sent once when configuring the endpoint).
  if (payload.type === "url_verification") {
    return Response.json({ challenge: payload.challenge });
  }

  // 2. Event callbacks.
  if (payload.type === "event_callback") {
    const event = payload.event ?? {};

    // Only act on genuine user DMs. Ignore the bot's own echoes, message edits
    // / deletions (subtype set), and channel-join noise — prevents feedback loops.
    const isUserDm =
      event.type === "message" &&
      event.channel_type === "im" &&
      !event.bot_id &&
      !event.subtype &&
      typeof event.user === "string" &&
      typeof event.text === "string";

    if (isUserDm) {
      // Ack within Slack's 3s window; do the DB + reply work afterwards.
      waitUntil(handleCommand(event.user, event.text));
    }
  }

  // Always acknowledge fast so Slack doesn't retry.
  return new Response("ok", { status: 200 });
}
