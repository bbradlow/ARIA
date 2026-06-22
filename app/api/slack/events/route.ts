import { NextRequest } from "next/server";
import { waitUntil } from "@vercel/functions";
import { getSupabase } from "@/lib/supabase";
import { postSlackMessage, updateSlackMessage, getBotUserId, getRecentMessages, getThreadMessages, getThreadRootText, verifySlackSignature } from "@/lib/slack";
import { answerQuestion, researchJoke } from "@/lib/qa";
import { askAffinity, latestReachouts } from "@/lib/affinity";

// node crypto (signature verification) requires the Node.js runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Raised so multi-step Affinity writes can finish. NOTE: cap by your Vercel
// plan — Hobby max is 60, Pro allows up to 300. If a deploy fails on this line,
// lower it to your plan's limit (and lower AFFINITY_TIMEOUT_MS to match).
export const maxDuration = 300;

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

// $joke: a one-line joke riffing on the research embedding library. Returns true if handled.
async function tryJoke(channel: string, text: string, replyTo?: string): Promise<boolean> {
  if (!/^\$joke\b/i.test(text.trim())) return false;
  try {
    const joke = await researchJoke();
    await postSlackMessage(channel, joke, replyTo);
  } catch (err) {
    console.error("Joke handler failed:", err);
    try {
      await postSlackMessage(channel, "Sorry — couldn't come up with one right now.", replyTo);
    } catch {}
  }
  return true;
}

// $afflat: a batch reach-out report for a list of companies (comma- or
// newline-separated). One-shot — no thread continuation. Returns true if handled.
async function tryAffinityLatest(
  channel: string,
  text: string,
  replyTo?: string
): Promise<boolean> {
  if (!/^\$afflat\b/i.test(text.trim())) return false;

  let placeholderTs: string | null = null;
  try {
    placeholderTs = await postSlackMessage(channel, "_Pulling latest reach-out data from Affinity…_", replyTo);
  } catch {}

  try {
    const answer = await latestReachouts(text);
    if (placeholderTs) await updateSlackMessage(channel, placeholderTs, answer);
    else await postSlackMessage(channel, answer, replyTo);
  } catch (err) {
    console.error("Affinity latest handler failed:", err);
    const reason = err instanceof Error ? err.message : String(err);
    const msg = `Sorry — I hit an error building the reach-out report.\n\`${reason.slice(0, 300)}\``;
    try {
      if (placeholderTs) await updateSlackMessage(channel, placeholderTs, msg);
      else await postSlackMessage(channel, msg, replyTo);
    } catch {}
  }
  return true;
}

// Route to the Affinity CRM handler when the message either (a) starts with
// $aff, or (b) is a reply inside a thread that was started with $aff — so you
// don't have to repeat the prefix to keep talking to Affinity in that thread.
// Replies post into the thread rooted at the triggering message (replyTo), and
// multi-turn context is that thread's history. Returns true if handled.
async function tryAffinity(
  channel: string,
  text: string,
  botId: string,
  replyTo?: string,
  threadTs?: string
): Promise<boolean> {
  const trimmed = text.trim();
  const isExplicit = /^\$aff\b/i.test(trimmed);

  // No prefix, but in a thread? Continue Affinity mode if the thread's root
  // message was a $aff command.
  let inAffinityThread = false;
  if (!isExplicit && threadTs) {
    try {
      const root = await getThreadRootText(channel, threadTs);
      inAffinityThread = /^\$aff\b/i.test(root.replace(/<@\w+>/g, "").trim());
    } catch (err) {
      console.error("Affinity thread check failed:", err);
    }
  }
  if (!isExplicit && !inAffinityThread) return false;

  // Gather context BEFORE posting the placeholder, so it isn't fed back as input.
  let history: { role: "user" | "assistant"; content: string }[] = [];
  try {
    history = replyTo
      ? await getThreadMessages(channel, replyTo, botId)
      : await getRecentMessages(channel, botId, 12);
  } catch (err) {
    console.error("Affinity history fetch failed:", err);
  }

  // Post an immediate placeholder so the user sees progress; we edit it in place
  // with the final answer (or error). Long writes then aren't dead air.
  let placeholderTs: string | null = null;
  try {
    placeholderTs = await postSlackMessage(channel, "_Working through Affinity…_", replyTo);
  } catch {}

  try {
    const fallback = [
      { role: "user" as const, content: trimmed.replace(/^\$aff\b/i, "").trim() },
    ];
    const answer = await askAffinity(history.length > 0 ? history : fallback);
    if (placeholderTs) await updateSlackMessage(channel, placeholderTs, answer);
    else await postSlackMessage(channel, answer, replyTo);
  } catch (err) {
    console.error("Affinity handler failed:", err);
    const reason = err instanceof Error ? err.message : String(err);
    const msg = `Sorry — I hit an error querying Affinity.\n\`${reason.slice(0, 300)}\``;
    try {
      if (placeholderTs) await updateSlackMessage(channel, placeholderTs, msg);
      else await postSlackMessage(channel, msg, replyTo);
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
      if (await tryJoke(event.channel, text, event.thread_ts ?? event.ts)) return;
      if (await tryAffinityLatest(event.channel, text, event.thread_ts ?? event.ts)) return;
      let botId = "";
      try {
        botId = await getBotUserId();
      } catch {}
      if (botId && (await tryAffinity(event.channel, text, botId, event.thread_ts ?? event.ts, event.thread_ts))) return;
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
    if (await tryJoke(event.channel, question, event.thread_ts ?? event.ts)) return;
    if (await tryAffinityLatest(event.channel, question, event.thread_ts ?? event.ts)) return;
    if (await tryAffinity(event.channel, question, botId, event.thread_ts ?? event.ts, event.thread_ts)) return;
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
      if (await tryJoke(channel, stripped, event.thread_ts ?? event.ts)) return;
      if (await tryAffinityLatest(channel, stripped, event.thread_ts ?? event.ts)) return;
      if (await tryAffinity(channel, stripped, botId, event.thread_ts ?? event.ts, event.thread_ts)) return;
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
