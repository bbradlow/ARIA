import { NextRequest } from "next/server";
import crypto from "crypto";
import { getSupabase } from "@/lib/supabase";
import { listArticleUrls, fetchArticle, ingestArticle } from "@/lib/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Stop ingesting before Vercel's 60s function limit, then return so you can
// call again to continue.
const TIME_BUDGET_MS = 45000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

const NO_CACHE = { "Cache-Control": "no-store" };

export async function GET(req: NextRequest) {
  if (!verify(req)) return new Response("Forbidden", { status: 403, headers: NO_CACHE });

  const started = Date.now();
  try {
    const supabase = getSupabase();
    const allUrls = await listArticleUrls();

    // Robust dedup: fetch the URLs already stored (limited to this article set)
    // in ONE query and compare in memory.
    const stored = new Set<string>();
    {
      const { data, error } = await supabase
        .from("research_chunks")
        .select("article_url")
        .in("article_url", allUrls);
      if (error) throw error;
      for (const row of data ?? []) {
        if (row.article_url) stored.add(row.article_url as string);
      }
    }

    const pending = allUrls.filter((u) => !stored.has(u));
    const ingested: { url: string; chunks: number }[] = [];
    const failed: { url: string; error: string }[] = [];

    for (const url of pending) {
      if (Date.now() - started > TIME_BUDGET_MS) break;
      try {
        const article = await fetchArticle(url);
        const chunks = await ingestArticle(article);
        ingested.push({ url, chunks });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Ingest failed for ${url}:`, message);
        failed.push({ url, error: message });
      }
      await sleep(200);
    }

    const remaining = pending.length - ingested.length;
    let note: string;
    if (pending.length === 0) {
      note = "All articles are already ingested.";
    } else if (failed.length > 0) {
      note = `${failed.length} article(s) failed this run — see failed[]. If they are rate-limit errors, wait a moment and call again.`;
    } else if (remaining > 0) {
      note = "Time budget reached — call this URL again to continue.";
    } else {
      note = "All articles are now ingested.";
    }

    return Response.json(
      {
        total_articles: allUrls.length,
        already_stored: stored.size,
        pending_before_run: pending.length,
        ingested_this_run: ingested.length,
        failed_this_run: failed.length,
        remaining,
        ingested,
        failed,
        note,
      },
      { headers: NO_CACHE }
    );
  } catch (err) {
    console.error("Ingest crawl failed:", err);
    return new Response("Ingest error", { status: 500, headers: NO_CACHE });
  }
}
