import { NextRequest } from "next/server";
import { waitUntil } from "@vercel/functions";
import { getSupabase } from "@/lib/supabase";
import { postSlackMessage, getBotUserId, verifySlackSignature } from "@/lib/slack";

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
const CHANNEL_WELCOME =
  "👋 I'll post a summary in this channel whenever a new Activant Capital research newsletter is published. Remove me from the channel to stop.";
const GROUP_WELCOME =
  "👋 Added! I'll post a summary in this group whenever a new Activant Capital research newsletter is published. Type `stop` here to turn it off.";
const GROUP_STOP_REPLY =
  "👋 Done — I'll stop posting research summaries in this group.";

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

// 1:1 DM to the bot: subscribe / unsubscribe / help.
async function handleDirectMessage(event: SlackEvent): Promise<void> {
  if (event.bot_id || event.subtype) return;
  if (!event.user || !event.channel) return;

  const command = (event.text ?? "").trim().toLowerCase();
  const supabase = getSupabase();

  try {
    if (command === "subscribe") {
      const { error } = await supabase
        .from("subscribers")
        .upsert(
          { slack_user_id: event.user },
          { onConflict: "slack_user_id", ignoreDuplicates: true }
        );
      if (error) throw error;
      await postSlackMessage(event.channel, SUBSCRIBE_REPLY);
    } else if (command === "unsubscribe") {
      const { error } = await supabase
        .from("subscribers")
        .delete()
        .eq("slack_user_id", event.user);
      if (error) throw error;
      await postSlackMessage(event.channel, UNSUBSCRIBE_REPLY);
    } else {
      await postSlackMessage(event.channel, HELP_REPLY);
    }
  } catch (err) {
    console.error("Failed to handle Slack DM:", err);
  }
}

// Multi-person DM (group chat). There's no "added to mpim" event, so we
// register the group the first time we see a message in it, and post a one-time
// welcome. Anyone can type `stop` to deregister it.
async function handleGroupMessage(event: SlackEvent): Promise<void> {
  if (event.bot_id || event.subtype) return;
  if (!event.channel) return;

  const command = (event.text ?? "").trim().toLowerCase();
  const supabase = getSupabase();

  try {
    if (command === "stop" || command === "unsubscribe" || command === "leave") {
      const { error } = await supabase
        .from("channels")
        .delete()
        .eq("slack_channel_id", event.channel);
      if (error) throw error;
      await postSlackMessage(event.channel, GROUP_STOP_REPLY);
      return;
    }

    // Register on first sight; welcome only when newly inserted (so we don't
    // greet on every message). A unique-violation means it's already known.
    const { error } = await supabase
      .from("channels")
      .insert({ slack_channel_id: event.channel });
    if (!error) {
      await postSlackMessage(event.channel, GROUP_WELCOME);
    } else if ((error as { code?: string }).code !== "23505") {
      throw error;
    }
  } catch (err) {
    console.error("Failed to handle group message:", err);
  }
}

// Bot added to / removed from a channel. member_joined_channel fires for every
// member, so act only when the member is the bot itself.
async function handleChannelMembership(
  event: SlackEvent,
  joined: boolean
): Promise<void> {
  if (!event.channel || !event.user) return;

  let botUserId: string;
  try {
    botUserId = await getBotUserId();
  } catch (err) {
    console.error("Could not resolve bot user id:", err);
    return;
  }
  if (event.user !== botUserId) return;

  const supabase = getSupabase();
  try {
    if (joined) {
      const { error } = await supabase
        .from("channels")
        .upsert(
          { slack_channel_id: event.channel },
          { onConflict: "slack_channel_id", ignoreDuplicates: true }
        );
      if (error) throw error;
      await postSlackMessage(event.channel, CHANNEL_WELCOME);
    } else {
      const { error } = await supabase
        .from("channels")
        .delete()
        .eq("slack_channel_id", event.channel);
      if (error) throw error;
    }
  } catch (err) {
    console.error("Failed to update channel membership:", err);
  }
}

async function handleEvent(event: SlackEvent): Promise<void> {
  switch (event.type) {
    case "message":
      if (event.channel_type === "mpim") {
        await handleGroupMessage(event);
      } else {
        // "im" — a 1:1 DM with the bot.
        await handleDirectMessage(event);
      }
      break;
    case "member_joined_channel":
      await handleChannelMembership(event, true);
      break;
    case "member_left_channel":
      await handleChannelMembership(event, false);
      break;
    default:
      break;
  }
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const timestamp = req.headers.get("x-slack-request-timestamp");
  const signature = req.headers.get("x-slack-signature");

  if (!verifySlackSignature(rawBody, timestamp, signature)) {
    return new Response("Forbidden", { status: 403 });
  }

  let envelope: SlackEnvelope;
  try {
    envelope = JSON.parse(rawBody) as SlackEnvelope;
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  if (envelope.type === "url_verification") {
    return Response.json({ challenge: envelope.challenge });
  }

  // Ack Slack retries immediately and skip reprocessing.
  if (req.headers.get("x-slack-retry-num")) {
    return new Response("ok", { status: 200 });
  }

  if (envelope.type === "event_callback" && envelope.event) {
    waitUntil(handleEvent(envelope.event));
  }

  return new Response("ok", { status: 200 });
}
