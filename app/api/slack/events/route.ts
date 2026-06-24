import { NextRequest } from "next/server";
import { waitUntil } from "@vercel/functions";
import { getSupabase } from "@/lib/supabase";
import { postSlackMessage, updateSlackMessage, getBotUserId, verifySlackSignature } from "@/lib/slack";
import { answerQuestion, researchJoke } from "@/lib/qa";
import { logEvent } from "@/lib/metrics";
import {
  isReservedName,
  defineCommand,
  deleteCommand,
  getCommand,
  listCommands,
  runCustomCommand,
} from "@/lib/commands";

// node crypto (signature verification) requires the Node.js runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Research Q&A and custom commands finish quickly; 60s is plenty.
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

// User-defined commands + their management verbs ($def / $undef / $commands).
// Built-ins ($joke) are reserved and fall through to their own handler. Custom
// commands are prompt macros — text in, text out, no code.
async function tryUserCommands(
  channel: string,
  text: string,
  userId: string | undefined,
  replyTo?: string
): Promise<boolean> {
  const m = text.trim().match(/^\$([a-zA-Z][a-zA-Z0-9_]*)\b\s*([\s\S]*)$/);
  if (!m) return false;
  const name = m[1].toLowerCase();
  const args = (m[2] || "").trim();
  const say = async (msg: string) => {
    try {
      await postSlackMessage(channel, msg, replyTo);
    } catch {}
  };

  // --- management verbs ---
  if (name === "def") {
    const dm = args.match(/^([a-zA-Z][a-zA-Z0-9_]*)\s+([\s\S]+)$/);
    if (!dm) {
      await say("Usage: `$def <name> <prompt>` — put `{input}` where the caller's text should go (e.g. `$def tldr Summarize in 3 bullets: {input}`).");
      return true;
    }
    const cname = dm[1].toLowerCase();
    if (isReservedName(cname)) {
      await say(`\`$${cname}\` is reserved and can't be redefined.`);
      return true;
    }
    try {
      await defineCommand(cname, dm[2].trim(), userId ?? "unknown");
      await say(`Saved \`$${cname}\`. Use it like \`$${cname} <your input>\`; remove it with \`$undef ${cname}\`.`);
    } catch (e) {
      await say(`Couldn't save that command: ${e instanceof Error ? e.message : String(e)}`);
    }
    return true;
  }
  if (name === "undef" || name === "delete" || name === "remove") {
    const cname = args.split(/\s+/)[0]?.toLowerCase();
    if (!cname) {
      await say("Usage: `$undef <name>`");
      return true;
    }
    if (isReservedName(cname)) {
      await say(`\`$${cname}\` is built-in and can't be removed.`);
      return true;
    }
    try {
      await deleteCommand(cname);
      await say(`Removed \`$${cname}\`.`);
    } catch (e) {
      await say(`Couldn't remove that: ${e instanceof Error ? e.message : String(e)}`);
    }
    return true;
  }
  if (name === "commands" || name === "list") {
    try {
      const cmds = await listCommands();
      if (!cmds.length) await say("No custom commands yet. Create one with `$def <name> <prompt>`.");
      else await say("*Custom commands:*\n" + cmds.map((c) => `• \`$${c.name}\``).join("\n"));
    } catch (e) {
      await say(`Couldn't list commands: ${e instanceof Error ? e.message : String(e)}`);
    }
    return true;
  }

  if (name === "all" || name === "help") {
    let custom: string[] = [];
    try {
      custom = (await listCommands()).map((c) => `\`$${c.name}\``);
    } catch {}
    const lines = [
      "*ARIA commands:*",
      "• `$joke` — a one-liner riffing on the research library.",
      "• `$def <name> <prompt>` — make your own command (use `{input}` where the caller's text goes). `$undef <name>` removes it.",
      "• `$commands` — list custom commands. `$all` — show this list.",
      "• Or just ask a question with no prefix and I'll search the research library (e.g. \"what's the latest research?\").",
    ];
    if (custom.length) lines.push("*Custom commands:* " + custom.join(", "));
    await say(lines.join("\n"));
    return true;
  }

  // Built-ins handle themselves.
  if (isReservedName(name)) return false;

  // --- custom command lookup ---
  let cmd = null;
  try {
    cmd = await getCommand(name);
  } catch {}
  if (!cmd) {
    await say(`No \`$${name}\` command yet. See \`$commands\`, or create it with \`$def ${name} <prompt>\`.`);
    return true;
  }

  let placeholderTs: string | null = null;
  try {
    placeholderTs = await postSlackMessage(channel, `_Running \`$${name}\`…_`, replyTo);
  } catch {}
  try {
    const out = await runCustomCommand(cmd, args);
    if (placeholderTs) await updateSlackMessage(channel, placeholderTs, out);
    else await say(out);
    await logEvent("ARIA", "custom_command", { userId, metadata: { name } });
  } catch (e) {
    console.error("Custom command failed:", e);
    const msg = `Sorry — \`$${name}\` failed.\n\`${(e instanceof Error ? e.message : String(e)).slice(0, 200)}\``;
    if (placeholderTs) {
      try {
        await updateSlackMessage(channel, placeholderTs, msg);
      } catch {}
    } else await say(msg);
  }
  return true;
}

// $joke: a one-line joke riffing on the research embedding library. Returns true if handled.
async function tryJoke(channel: string, text: string, replyTo?: string): Promise<boolean> {
  if (!/^\$joke\b/i.test(text.trim())) return false;
  try {
    const joke = await researchJoke();
    await postSlackMessage(channel, joke, replyTo);
    await logEvent("ARIA", "joke");
  } catch (err) {
    console.error("Joke handler failed:", err);
    try {
      await postSlackMessage(channel, "Sorry — couldn't come up with one right now.", replyTo);
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
      await logEvent("ARIA", "subscribe", { userId: event.user });
    } else if (cmd === "unsubscribe") {
      const { error } = await supabase
        .from("subscribers")
        .delete()
        .eq("slack_user_id", event.user);
      if (error) throw error;
      await postSlackMessage(event.channel, UNSUBSCRIBE_REPLY);
      await logEvent("ARIA", "unsubscribe", { userId: event.user });
    } else if (cmd === "help" || cmd === "") {
      await postSlackMessage(event.channel, HELP_REPLY);
    } else {
      if (await tryUserCommands(event.channel, text, event.user, event.thread_ts ?? event.ts)) return;
      if (await tryJoke(event.channel, text, event.thread_ts ?? event.ts)) return;
      const answer = await answerQuestion(text);
      await postSlackMessage(event.channel, answer);
      await logEvent("ARIA", "research_query", { userId: event.user, metadata: { surface: "dm" } });
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
    if (await tryUserCommands(event.channel, question, event.user, event.thread_ts ?? event.ts)) return;
    if (await tryJoke(event.channel, question, event.thread_ts ?? event.ts)) return;
    const answer = await answerQuestion(question);
    await postSlackMessage(event.channel, answer, threadTs);
    await logEvent("ARIA", "research_query", { userId: event.user, metadata: { surface: "channel" } });
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
      if (await tryUserCommands(channel, stripped, event.user, event.thread_ts ?? event.ts)) return;
      if (await tryJoke(channel, stripped, event.thread_ts ?? event.ts)) return;
      const answer = await answerQuestion(stripped);
      await postSlackMessage(channel, answer);
      await logEvent("ARIA", "research_query", { userId: event.user, metadata: { surface: "group" } });
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
