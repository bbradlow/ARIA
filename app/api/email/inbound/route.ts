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

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * SendGrid Inbound Parse does not sign its webhooks, so we secure this endpoint
 * with a shared secret carried in the destination URL's query string
 * (?token=...). Configure that full URL in SendGrid -> Settings -> Inbound
 * Parse. Requests with a missing or wrong token get a 403.
 */
function verifyToken(req: NextRequest): boolean {
  const expected = process.env.SENDGRID_INBOUND_TOKEN;
  if (!expected) return false;
  const provided = req.nextUrl.searchParams.get("token");
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
function extractBody(text: string, html: string): string {
  const t = text.trim();
  if (t.length >= 200) return t;
  if (html && html.trim().length > 0) {
    const stripped = htmlToText(html);
    if (stripped.length > t.length) return stripped;
  }
  return t;
}

/**
 * SendGrid doesn't hand us a tidy unique id, so we pull the RFC `Message-ID`
 * out of the raw `headers` field. If it's missing, fall back to a stable hash
 * of the subject + body so retries of the same email still dedupe correctly.
 */
function deriveMessageId(headers: string, subject: string, body: string): string {
  const match = headers.match(/^Message-ID:\s*(.+)$/im);
  if (match) return match[1].trim();
  return (
    "sha256:" +
    crypto
      .createHash("sha256")
      .update(`${subject}\n${body.slice(0, 4000)}`)
      .digest("hex")
  );
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
  // Verify the shared secret in the query string.
  if (!verifyToken(req)) {
    return new Response("Forbidden", { status: 403 });
  }

  // SendGrid Inbound Parse POSTs multipart/form-data, not JSON. The default
  // "parsed" mode gives us individual fields (text, html, subject, headers...).
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const subject =
    ((form.get("subject") as string) || "").trim() || "New Activant Research";
  const text = (form.get("text") as string) || "";
  const html = (form.get("html") as string) || "";
  const headers = (form.get("headers") as string) || "";

  const body = extractBody(text, html);
  if (!body) {
    // Nothing usable to summarize; ack so SendGrid doesn't keep retrying.
    return Response.json({ status: "empty", subscribers_notified: 0 });
  }

  const messageId = deriveMessageId(headers, subject, body);
  const supabase = getSupabase();

  // Deduplicate by atomically *claiming* the message id up front. The unique
  // constraint on `message_id` means a duplicate insert fails — that failure is
  // our signal the email was already processed (e.g. a SendGrid retry), so we
  // ack with 200 and do nothing. Claiming first (rather than check-then-insert)
  // closes the race where two concurrent retries both pass an existence check.
  const { error: claimError } = await supabase
    .from("processed_emails")
    .insert({ message_id: messageId, subject });

  if (claimError) {
    // 23505 = unique_violation -> already processed.
    if ((claimError as { code?: string }).code === "23505") {
      return Response.json({ status: "duplicate", subscribers_notified: 0 });
    }
    console.error("Failed to claim message:", claimError);
    return new Response("Database error", { status: 500 });
  }

  try {
    // Summarize via OpenRouter.
    const summary = await summarize(subject, body);

    // Fan out to every subscriber.
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

    return Response.json({ status: "ok", subscribers_notified: notified });
  } catch (err) {
    // Processing failed *after* claiming the message. Release the claim so a
    // SendGrid retry can re-attempt the full job, then signal failure.
    console.error("Processing failed, releasing claim:", err);
    await supabase.from("processed_emails").delete().eq("message_id", messageId);
    return new Response("Processing error", { status: 500 });
  }
}
