import { NextRequest } from "next/server";
import { waitUntil } from "@vercel/functions";
import { getSupabase } from "@/lib/supabase";
import { sendSlackDM, verifySlackSignature } from "@/lib/slack";

// node crypto (signature verification) requires the Node.js runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUBSCRIBE_REPLY =
  "✅ You're subscribed! You'll receive a DM summary every time a new Activant Capital research newsletter arrives.";
const UNSUBSCRIBE_REPLY =
  "👋 You've been unsubscribed and won't receive any more research alerts.";
const HELP_REPLY =
  "👋 Hi! I send summaries of new Activant Capital research emails directly to you.\n" +
  "• Type `subscribe` to start receiving alerts.\n" +
  "• Type `unsubscribe` to stop.";

interface SlackEvent {
  type?: string;
  subtype?: string;
  bot_id?: string;
  user?: string;
  text?: string;
  channel?: string;
  channel_type?: string;
}

interface SlackEnvelope {
  type: string;
  challenge?: string;
  event?: SlackEvent;
}

async function handleMessage(event: SlackEvent): Promise<void> {
  // Ignore bot messages and message subtypes (edits, joins, the bot's own
  // replies, etc.) to prevent feedback loops.
  if (event.bot_id || event.subtype) return;
  if (event.type !== "message" || !event.user || !event.channel) return;

  const command = (event.text ?? "").trim().toLowerCase();
  const supabase = getSupabase();

  try {
    if (command === "subscribe") {
      // Idempotent insert — ignore if the user is already subscribed.
      const { error } = await supabase
        .from("subscribers")
        .upsert(
          { slack_user_id: event.user },
          { onConflict: "slack_user_id", ignoreDuplicates: true }
        );
      if (error) throw error;
      await sendSlackDM(event.channel, SUBSCRIBE_REPLY);
    } else if (command === "unsubscribe") {
      const { error } = await supabase
        .from("subscribers")
        .delete()
        .eq("slack_user_id", event.user);
      if (error) throw error;
      await sendSlackDM(event.channel, UNSUBSCRIBE_REPLY);
    } else {
      await sendSlackDM(event.channel, HELP_REPLY);
    }
  } catch (err) {
    console.error("Failed to handle Slack message:", err);
  }
}

export async function POST(req: NextRequest) {
  // We need the exact raw body for signature verification, so read it as text
  // and parse it ourselves afterwards.
  const rawBody = await req.text();
  const timestamp = req.headers.get("x-slack-request-timestamp");
  const signature = req.headers.get("x-slack-signature");

  // 6a. Verify the Slack request signature.
  if (!verifySlackSignature(rawBody, timestamp, signature)) {
    return new Response("Forbidden", { status: 403 });
  }

  let envelope: SlackEnvelope;
  try {
    envelope = JSON.parse(rawBody) as SlackEnvelope;
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  // 6b. Respond to the one-time URL verification challenge.
  if (envelope.type === "url_verification") {
    return Response.json({ challenge: envelope.challenge });
  }

  // Slack retries delivery (within a few seconds) if it doesn't get a 200 fast
  // enough. We ack retries immediately and skip reprocessing — the original
  // delivery is already being handled asynchronously below.
  if (req.headers.get("x-slack-retry-num")) {
    return new Response("ok", { status: 200 });
  }

  // 6c. Hand the event off to async processing and ack within Slack's
  // 3-second window. `waitUntil` keeps the function alive until the work
  // completes even though we've already returned the response.
  if (envelope.type === "event_callback" && envelope.event) {
    waitUntil(handleMessage(envelope.event));
  }

  return new Response("ok", { status: 200 });
}
