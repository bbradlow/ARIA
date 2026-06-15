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
// register the group the first time we see a message in it. To avoid casual
// chatter toggling the bot, the stop/start commands must @mention the bot;
// pausing is durable (active=false) and only an explicit start resumes it.
async function handleGroupMessage(event: SlackEvent): Promise<void> {
  if (event.bot_id || event.subtype) return;
  if (!event.channel) return;

  let botUserId: string;
  try {
    botUserId = await getBotUserId();
  } catch (err) {
    console.error("Could not resolve bot user id:", err);
    return;
  }

  const raw = event.text ?? "";
  const lower = raw.toLowerCase();
  const mentioned = raw.includes(`<@${botUserId}>`);
  const wantsStop = /\b(stop|unsubscribe|leave|pause)\b/.test(lower);
  const wantsStart = /\b(start|subscribe|resume|begin)\b/.test(lower);

  const channel = event.channel;
  const supabase = getSupabase();
  const welcome =
    `👋 I'll post a summary in this group whenever a new Activant Capital research ` +
    `newsletter is published. To pause me, mention me with "stop" (e.g. <@${botUserId}> stop); ` +
    `mention me with "start" to resume.`;

  try {
    // Commands must @mention the bot — so someone typing "stop" mid-conversation
    // never accidentally toggles anything.
    if (mentioned && wantsStop) {
      const { error } = await supabase
        .from("channels")
        .upsert(
          { slack_channel_id: channel, active: false },
          { onConflict: "slack_channel_id" }
        );
      if (error) throw error;
      await postSlackMessage(
        channel,
        '👋 Paused — I\'ll stop posting here. Mention me with "start" to resume.'
      );
      return;
    }
    if (mentioned && wantsStart) {
      const { error } = await supabase
        .from("channels")
        .upsert(
          { slack_channel_id: channel, active: true },
          { onConflict: "slack_channel_id" }
        );
      if (error) throw error;
      await postSlackMessage(channel, welcome);
      return;
    }

    // Not a command: auto-register on first sight only. If a row already exists
    // (active or paused), leave its state untouched — chatter never reactivates
    // a paused group.
    const { error } = await supabase
      .from("channels")
      .insert({ slack_channel_id: channel, active: true });
    if (!error) {
      await postSlackMessage(channel, welcome);
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
          { slack_channel_id: event.channel, active: true },
          { onConflict: "slack_channel_id" }
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

  if (req.headers.get("x-slack-retry-num")) {
    return new Response("ok", { status: 200 });
  }

  if (envelope.type === "event_callback" && envelope.event) {
    waitUntil(handleEvent(envelope.event));
  }

  return new Response("ok", { status: 200 });
}
