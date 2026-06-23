import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { fetchArticle } from "@/lib/ingest";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Backfill the published_at date on already-ingested research chunks WITHOUT
 * re-embedding. For each distinct article URL it re-fetches the page, reads the
 * visible "Published Month YYYY" date, and updates that article's rows.
 *
 * Usage: GET /api/backfill-dates?token=INGEST_TOKEN
 *   - default: only articles missing a date
 *   - &all=true: re-date every article (e.g. to fix wrong dates)
 * Re-run until "remaining": 0 (it works in ~45s time slices).
 */
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  if (!process.env.INGEST_TOKEN || token !== process.env.INGEST_TOKEN) {
    return NextResponse.json(
      { error: "unauthorized" },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
  }

  const onlyMissing = req.nextUrl.searchParams.get("all") !== "true";
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("research_chunks")
    .select("article_url, published_at")
    .not("article_url", "is", null);
  if (error) {
    return NextResponse.json(
      { error: error.message },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }

  // Collapse chunks to distinct URLs, tracking whether any chunk already has a date.
  const hasDateByUrl = new Map<string, boolean>();
  for (const row of data ?? []) {
    const url = (row as any).article_url as string;
    const hasDate = !!(row as any).published_at;
    hasDateByUrl.set(url, (hasDateByUrl.get(url) ?? false) || hasDate);
  }

  let urls = [...hasDateByUrl.keys()];
  if (onlyMissing) urls = urls.filter((u) => !hasDateByUrl.get(u));
  const targeted = urls.length;

  const start = Date.now();
  const BUDGET_MS = 45000;
  let processed = 0;
  let dated = 0;
  let noDateFound = 0;
  let failed = 0;

  for (const url of urls) {
    if (Date.now() - start > BUDGET_MS) break;
    processed++;
    try {
      const article = await fetchArticle(url);
      if (article.publishedAt) {
        const { error: upErr } = await supabase
          .from("research_chunks")
          .update({ published_at: article.publishedAt })
          .eq("article_url", url);
        if (upErr) {
          failed++;
          continue;
        }
        dated++;
      } else {
        noDateFound++;
      }
    } catch {
      failed++;
    }
  }

  return NextResponse.json(
    {
      total_articles: hasDateByUrl.size,
      targeted,
      processed,
      dated_this_run: dated,
      no_date_found: noDateFound,
      failed_this_run: failed,
      remaining: Math.max(0, targeted - processed),
      note:
        "Re-run until remaining:0. Pages without a visible 'Published Month YYYY' come back as no_date_found. Add &all=true to re-date every article (not just missing ones).",
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
