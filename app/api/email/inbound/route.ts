import { NextRequest } from "next/server";
import * as cheerio from "cheerio";
import crypto from "crypto";
import { getSupabase } from "@/lib/supabase";
import { postSlackMessage } from "@/lib/slack";
import { fetchArticle, ingestArticle } from "@/lib/ingest";

// cheerio + node crypto require the Node.js runtime (not Edge).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Summarization + fan-out can take a while; give the function headroom.
export const maxDuration = 60;

interface PostmarkInbound {
  MessageID?: string;
  Subject?: string;
  TextBody?: string;
  HtmlBody?: string;
  StrippedTextReply?: string;
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Postmark does not HMAC-sign inbound webhooks, so we secure this endpoint with
 * a shared secret supplied as a `?token=` query parameter (configured on the
 * Postmark webhook URL) or an `X-Postmark-Webhook-Token` header.
 */
function verifyPostmark(req: NextRequest): boolean {
  const expected = process.env.POSTMARK_WEBHOOK_TOKEN;
  if (!expected) return false;
  const provided =
    req.nextUrl.searchParams.get("token") ??
    req.headers.get("x-postmark-webhook-token");
  if (!provided) return false;
  return timingSafeEqualStr(provided, expected);
}

function htmlToText(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, head, noscript").remove();
  return $("body")
    .text()
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractBody(payload: PostmarkInbound): string {
  const text = (payload.TextBody ?? "").trim();
  if (text.length >= 200) return text;
  if (payload.HtmlBody && payload.HtmlBody.trim().length > 0) {
    const stripped = htmlToText(payload.HtmlBody);
    if (stripped.length > text.length) return stripped;
  }
  return text;
}

/**
 * Best-effort extraction of the "read the full article" link. Prefers a link
 * whose anchor text hints at the article ("read more", "full", "view online"),
 * then any activantcapital.com link, then any link — skipping obvious junk
 * (unsubscribe, social, images). Falls back to scanning the plain text.
 */
function extractArticleUrl(html: string, text: string): string | null {
  const isJunk = (h: string) =>
    /unsubscribe|mailto:|utm_source=footer|list-manage|twitter\.com|x\.com|linkedin\.com|facebook\.com|instagram\.com|youtube\.com|\.png|\.jpe?g|\.gif/i.test(
      h
    );
  const isHttp = (h: string) => /^https?:\/\//i.test(h);

  if (html && html.trim().length > 0) {
    const $ = cheerio.load(html);
    const links: { href: string; text: string }[] = [];
    $("a[href]").each((_, el) => {
      links.push({
        href: ($(el).attr("href") || "").trim(),
        text: $(el).text().trim().toLowerCase(),
      });
    });
    const cue = /(read|full|view|article|continue|more|online)/;
    const cued = links.find((l) => cue.test(l.text) && isHttp(l.href) && !isJunk(l.href));
    if (cued) return cued.href;
    const site = links.find((l) => /activantcapital\.com/i.test(l.href) && !isJunk(l.href));
    if (site) return site.href;
    const any = links.find((l) => isHttp(l.href) && !isJunk(l.href));
    if (any) return any.href;
  }

  const siteMatch = text.match(/https?:\/\/[^\s)>\]]*activantcapital\.com[^\s)>\]]*/i);
  if (siteMatch) return siteMatch[0];
  const anyMatch = text.match(/https?:\/\/[^\s)>\]]+/i);
  return anyMatch ? anyMatch[0] : null;
}

async function summarize(title: string, body: string): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY environment variable");

  // The instructions and model are configurable via env vars so you can tune
  // them in the Vercel dashboard without editing code.
  const defaultPrompt =
    "You are a research analyst assistant. Given the full text of a research newsletter email, produce a concise executive summary for a Slack message to a team of investors. Structure the output as: (1) one or two sentences stating the core thesis; (2) a line reading *Key data points:* followed by each notable statistic or fact on its own separate line, each starting with the '•' character; (3) one short sentence with the takeaway. CRITICAL: every key data point bullet must be self-contained and independent. Never combine multiple statistics into a single sentence, and never join independent figures with connectives like 'yet', 'because', 'despite', or 'while' that imply a relationship between facts that are actually unrelated. One fact per bullet. Use Slack formatting: single asterisks for *bold*, no markdown headers. Do not include any preamble or sign-off — just the summary.";
  const systemPrompt = process.env.SUMMARY_SYSTEM_PROMPT?.trim() || defaultPrompt;
  const model = process.env.SUMMARY_MODEL?.trim() || "anthropic/claude-sonnet-4-5";

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://activantcapital.com",
      "X-Title": "Activant Research Bot",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Title: ${title}\n\n${body}` },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`OpenRouter request failed (${res.status}): ${errText}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const summary = data.choices?.[0]?.message?.content?.trim();
  if (!summary) throw new Error("OpenRouter returned an empty summary");
  return summary;
}

export async function POST(req: NextRequest) {
  if (!verifyPostmark(req)) {
    return new Response("Forbidden", { status: 403 });
  }

  let payload: PostmarkInbound;
  try {
    payload = (await req.json()) as PostmarkInbound;
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const messageId = payload.MessageID;
  if (!messageId) {
    return new Response("Missing MessageID", { status: 400 });
  }
  const subject = payload.Subject?.trim() || "New Activant Research";

  const supabase = getSupabase();

  // Claim the message id up front (atomic dedup via the unique constraint).
  const { error: claimError } = await supabase
    .from("processed_emails")
    .insert({ message_id: messageId, subject });

  if (claimError) {
    if ((claimError as { code?: string }).code === "23505") {
      return Response.json({ status: "duplicate", subscribers_notified: 0, channels_notified: 0 });
    }
    console.error("Failed to claim message:", claimError);
    return new Response("Database error", { status: 500 });
  }

  try {
    const body = extractBody(payload);
    if (!body) throw new Error("Email had no usable body to summarize");

    const summary = await summarize(subject, body);

    // Append the "read the full article" link in code (reliable — the model
    // never sees or rewrites the URL). Slack renders <url|label> as a link.
    const articleUrl = extractArticleUrl(payload.HtmlBody ?? "", body);
    let message = `📄 *${subject}*\n\n${summary}`;
    if (articleUrl) {
      message += `\n\n<${articleUrl}|Read the full piece →>`;
    }

    // Fan out to individual subscribers.
    let subscribersNotified = 0;
    const { data: subs, error: subsError } = await supabase
      .from("subscribers")
      .select("slack_user_id");
    if (subsError) throw subsError;
    for (const sub of subs ?? []) {
      try {
        await postSlackMessage(sub.slack_user_id, message);
        subscribersNotified += 1;
      } catch (err) {
        console.error(`Failed to DM ${sub.slack_user_id}:`, err);
      }
    }

    // Fan out to channels and group DMs the bot has been added to.
    let channelsNotified = 0;
    const { data: chans, error: chansError } = await supabase
      .from("channels")
      .select("slack_channel_id")
      .eq("active", true);
    if (chansError) throw chansError;
    for (const ch of chans ?? []) {
      try {
        await postSlackMessage(ch.slack_channel_id, message);
        channelsNotified += 1;
      } catch (err) {
        console.error(`Failed to post to channel ${ch.slack_channel_id}:`, err);
      }
    }

    // Auto-ingest into the research library (best-effort — never block or fail
    // the summary fan-out). Prefer the full article when we have its URL.
    // Canonical /research articles get dated from the index inside ingestArticle;
    // newsletter editions (Beehiiv tracking links / no URL) are "published" on
    // send, so we date them with today's date.
    const sendDate = new Date().toISOString().slice(0, 10);
    const isResearchUrl = !!articleUrl && /activantcapital\.com\/research\//i.test(articleUrl);
    try {
      if (articleUrl) {
        let toIngest;
        try {
          toIngest = await fetchArticle(articleUrl);
        } catch {
          toIngest = { title: subject, url: articleUrl, text: body };
        }
        if (!toIngest.publishedAt && !isResearchUrl) toIngest.publishedAt = sendDate;
        await ingestArticle(toIngest);
      } else {
        await ingestArticle({ title: subject, text: body, publishedAt: sendDate });
      }
    } catch (err) {
      console.error("Auto-ingest of newsletter failed:", err);
    }

    return Response.json({
      status: "ok",
      subscribers_notified: subscribersNotified,
      channels_notified: channelsNotified,
    });
  } catch (err) {
    console.error("Processing failed, releasing claim:", err);
    await supabase.from("processed_emails").delete().eq("message_id", messageId);
    return new Response("Processing error", { status: 500 });
  }
}
