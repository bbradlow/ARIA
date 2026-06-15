import { NextRequest } from "next/server";
import crypto from "crypto";
import { listArticleUrls, fetchArticle, ingestArticle, isArticleIngested } from "@/lib/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Articles to process per invocation, so the function stays within its time
// limit. Re-run the endpoint until "remaining" is 0.
const BATCH = 6;

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function verify(req: NextRequest): boolean {
  const expected = process.env.INGEST_TOKEN;
  if (!expected) return false;
  const provided = req.nextUrl.searchParams.get("token");
  return !!provided && timingSafeEqualStr(provided, expected);
}

// GET /api/ingest?token=...  → crawl the research index and ingest the next
// batch of not-yet-stored articles. Call repeatedly until remaining hits 0.
export async function GET(req: NextRequest) {
  if (!verify(req)) return new Response("Forbidden", { status: 403 });

  try {
    const allUrls = await listArticleUrls();
    const ingested: { url: string; chunks: number }[] = [];
    let remaining = 0;

    for (const url of allUrls) {
      let done: boolean;
      try {
        done = await isArticleIngested(url);
      } catch (err) {
        console.error(`Existence check failed for ${url}:`, err);
        continue;
      }
      if (done) continue;

      if (ingested.length >= BATCH) {
        remaining += 1;
        continue;
      }

      try {
        const article = await fetchArticle(url);
        const chunks = await ingestArticle(article);
        ingested.push({ url, chunks });
      } catch (err) {
        console.error(`Ingest failed for ${url}:`, err);
      }
    }

    return Response.json({
      total_articles: allUrls.length,
      ingested_this_run: ingested.length,
      remaining,
      details: ingested,
      note:
        remaining > 0
          ? "More articles remain — call this URL again to continue."
          : "All articles are ingested.",
    });
  } catch (err) {
    console.error("Ingest crawl failed:", err);
    return new Response("Ingest error", { status: 500 });
  }
}
