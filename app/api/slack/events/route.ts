import { NextRequest } from "next/server";
import { waitUntil } from "@vercel/functions";
import { getSupabase } from "@/lib/supabase";
import { postSlackMessage, getBotUserId, getThreadMessages, verifySlackSignature } from "@/lib/slack";
import { answerQuestion } from "@/lib/qa";
import { askAffinity } from "@/lib/affinity";

// node crypto (signature verification) requires the Node.js runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SUBSCRIBE_REPLY =
  "✅ You're subscribed! You'll receive a DM summary every time a new Activant Capital research newsletter arrives.";
const UNSUBSCRIBE_REPLY =
  "👋 You've been unsubscribed and won't receive any more research alerts.";
const HELP_REPLY =
  "👋 Hi! I summarize new Activant research and can answer questions about past research.\n" +
  "• Type `subscribe` to get DM summaries of new issues.\n" +
  "• Type `unsubscribe` to stop.\n" +
  "• Ask me anything else and I'll search the research library.";
const CHANNEL_WELCOME =
  "👋 I'll post a summary in this channel whenever a new Activant Capital research newsletter is published. Remove me from the channel to stop. @mention me with a question anytime.";

const STOP_WORDS = ["stop", "pause", "unsubscribe", "leave"];
const START_WORDS = ["start", "resume", "subscribe", "begin"];

interface SlackEvent {
  type?: string;
  subtype?: string;
  bot_id?: string;
  user?: string;
  text?: string;
  channel?: string;
  channel_type?: string;
  ts?: string;
  thread_ts?: string;
}

interface SlackEnvelope {
  type: string;
  challenge?: string;
  event?: SlackEvent;
}

function stripMention(text: string, botId: string): string {
  return (text || "").replace(new RegExp(`<@${botId}>`, "g"), "").trim();
}

// If the (mention-stripped) text starts with /aff, route to the Affinity CRM
// handler: pull the full thread for multi-turn context, answer via Claude + the
// Affinity MCP server, and reply in-thread. Returns true if it handled the message.
async function tryAffinity(
  channel: string,
  text: string,
  threadTs: string,
  botId: string
): Promise<boolean> {
  if (!/^\/aff\b/i.test(text.trim())) return false;

  try {
    const history = await getThreadMessages(channel, threadTs, botId);
    const fallback = [
      { role: "user" as const, content: text.trim().replace(/^\/aff\b/i, "").trim() },
    ];
    const answer = await askAffinity(history.length > 0 ? history : fallback);
    await postSlackMessage(channel, answer, threadTs);
  } catch (err) {
    console.error("Affinity handler failed:", err);
    try {
      await postSlackMessage(channel, "Sorry — I hit an error querying Affinity.", threadTs);
    } catch {}
  }
  return true;
}

// 1:1 DM: subscribe / unsubscribe / help commands, otherwise a question.
async function handleDirectMessage(event: SlackEvent): Promise<void> {
  if (event.bot_id || event.subtype) return;
  if (!event.user || !event.channel) return;

  const text = event.text ?? "";
  const cmd = text.trim().toLowerCase();
  const supabase = getSupabase();

  try {
    if (cmd === "subscribe") {
      const { error } = await supabase
        .from("subscribers")
        .upsert(
          { slack_user_id: event.user },
          { onConflict: "slack_user_id", ignoreDuplicates: true }
        );
      if (error) throw error;
      await postSlackMessage(event.channel, SUBSCRIBE_REPLY);
    } else if (cmd === "unsubscribe") {
      const { error } = await supabase
        .from("subscribers")
        .delete()
        .eq("slack_user_id", event.user);
      if (error) throw error;
      await postSlackMessage(event.channel, UNSUBSCRIBE_REPLY);
    } else if (cmd === "help" || cmd === "") {
      await postSlackMessage(event.channel, HELP_REPLY);
    } else {
      let botId = "";
      try {
        botId = await getBotUserId();
      } catch {}
      const threadTs = event.thread_ts ?? event.ts;
      if (botId && threadTs && (await tryAffinity(event.channel, text, threadTs, botId))) return;
      const answer = await answerQuestion(text);
      await postSlackMessage(event.channel, answer);
    }
  } catch (err) {
    console.error("Failed to handle Slack DM:", err);
    try {
      await postSlackMessage(event.channel, "Sorry — I hit an error handling that.");
    } catch {}
  }
}

// Channel @mention (app_mention event) — always treated as a question.
async function handleChannelMention(event: SlackEvent): Promise<void> {
  if (event.bot_id || !event.channel) return;

  let botId: string;
  try {
    botId = await getBotUserId();
  } catch (err) {
    console.error("Could not resolve bot user id:", err);
    return;
  }

  const question = stripMention(event.text ?? "", botId);
  const threadTs = event.thread_ts ?? event.ts;

  try {
    if (threadTs && (await tryAffinity(event.channel, question, threadTs, botId))) return;
    const answer = await answerQuestion(question);
    await postSlackMessage(event.channel, answer, threadTs);
  } catch (err) {
    console.error("Failed to answer channel mention:", err);
    try {
      await postSlackMessage(event.channel, "Sorry — I hit an error answering that.", threadTs);
    } catch {}
  }
}

// Group DM (message.mpim). Commands must @mention the bot and be exactly the
// command word. A mention with anything else is a question. A non-mention
// message registers the group for summaries on first sight.
async function handleGroupMessage(event: SlackEvent): Promise<void> {
  if (event.bot_id || event.subtype) return;
  if (!event.channel) return;

  let botId: string;
  try {
    botId = await getBotUserId();
  } catch (err) {
    console.error("Could not resolve bot user id:", err);
    return;
  }

  const raw = event.text ?? "";
  const mentioned = raw.includes(`<@${botId}>`);
  const stripped = stripMention(raw, botId);
  const lc = stripped.toLowerCase();

  const channel = event.channel;
  const supabase = getSupabase();
  const welcome =
    `👋 I'll post a summary in this group whenever a new Activant Capital research ` +
    `newsletter is published. To pause me, mention me with "stop" (e.g. <@${botId}> stop); ` +
    `mention me with "start" to resume. @mention me with a question anytime.`;

  try {
    if (mentioned && STOP_WORDS.includes(lc)) {
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
    if (mentioned && START_WORDS.includes(lc)) {
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
    if (mentioned) {
      // A question directed at the bot (doesn't change summary subscription).
      const threadTs = event.thread_ts ?? event.ts;
      if (threadTs && (await tryAffinity(channel, stripped, threadTs, botId))) return;
      const answer = await answerQuestion(stripped);
      await postSlackMessage(channel, answer);
      return;
    }

    // Not a command and not a mention: register on first sight; welcome only
    // when newly inserted (so we don't greet on every message). A paused group
    // stays paused — chatter never reactivates it.
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

// Bot added to / removed from a channel.
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
    case "app_mention":
      await handleChannelMention(event);
      break;
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
