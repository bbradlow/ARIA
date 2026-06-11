import { NextRequest } from "next/server";
import * as cheerio from "cheerio";
import crypto from "crypto";
import { getSupabase } from "@/lib/supabase";
import { sendSlackDM } from "@/lib/slack";

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
 * Postmark does not HMAC-sign inbound webhooks the way it signs other events,
 * so we secure this endpoint with a shared secret. The token can be supplied
 * either as a `?token=` query parameter (recommended — configure it on the
 * Postmark webhook URL) or via an `X-Postmark-Webhook-Token` header.
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

/**
 * Prefer the clean plain-text body. Fall back to stripping the HTML body when
 * the text version is empty or suspiciously short.
 */
function extractBody(payload: PostmarkInbound): string {
  const text = (payload.TextBody ?? "").trim();
  if (text.length >= 200) return text;

  if (payload.HtmlBody && payload.HtmlBody.trim().length > 0) {
    const stripped = htmlToText(payload.HtmlBody);
    if (stripped.length > text.length) return stripped;
  }
  return text;
}

async function summarize(title: string, body: string): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY environment variable");

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://activantcapital.com",
      "X-Title": "Activant Research Bot",
    },
    body: JSON.stringify({
      model: "anthropic/claude-sonnet-4-5",
      messages: [
        {
          role: "system",
          content:
            "You are a research analyst assistant. Given the full text of a research newsletter email, produce a concise 3-5 sentence executive summary suitable for a Slack DM to a team of investors. Highlight the core thesis, key data points, and takeaway. Do not include any preamble or sign-off — just the summary.",
        },
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
  // 5a. Verify the request genuinely came from Postmark.
  if (!verifyPostmark(req)) {
    return new Response("Forbidden", { status: 403 });
  }

  // 5b. Parse the payload.
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

  // 5c / 5f. Deduplicate by atomically *claiming* the message id up front.
  // The unique constraint on `message_id` means a duplicate insert fails — that
  // failure is our signal the email was already processed (e.g. a Postmark
  // retry), so we ack with 200 and do nothing. Claiming first (rather than a
  // check-then-insert later) closes the race window where two concurrent
  // retries could both pass a "does it exist?" check and double-send.
  const { error: claimError } = await supabase
    .from("processed_emails")
    .insert({ message_id: messageId, subject });

  if (claimError) {
    // 23505 = unique_violation → already processed.
    if ((claimError as { code?: string }).code === "23505") {
      return Response.json({ status: "duplicate", subscribers_notified: 0 });
    }
    console.error("Failed to claim message:", claimError);
    return new Response("Database error", { status: 500 });
  }

  try {
    const body = extractBody(payload);
    if (!body) throw new Error("Email had no usable body to summarize");

    // 5d. Summarize via OpenRouter.
    const summary = await summarize(subject, body);

    // 5e. Fan out to every subscriber.
    const { data: subs, error: subsError } = await supabase
      .from("subscribers")
      .select("slack_user_id");
    if (subsError) throw subsError;

    const message = `📄 *${subject}*\n\n${summary}`;
    let notified = 0;

    for (const sub of subs ?? []) {
      try {
        await sendSlackDM(sub.slack_user_id, message);
        notified += 1;
      } catch (err) {
        // A single failed DM must never abort the whole fan-out.
        console.error(`Failed to DM ${sub.slack_user_id}:`, err);
      }
    }

    // 5g. Done.
    return Response.json({ status: "ok", subscribers_notified: notified });
  } catch (err) {
    // Processing failed *after* claiming the message. Release the claim so a
    // Postmark retry can re-attempt the full job, then signal failure (non-200
    // tells Postmark to retry).
    console.error("Processing failed, releasing claim:", err);
    await supabase.from("processed_emails").delete().eq("message_id", messageId);
    return new Response("Processing error", { status: 500 });
  }
}
