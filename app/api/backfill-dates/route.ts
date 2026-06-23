import { NextRequest, NextResponse } from "next/server";
import * as cheerio from "cheerio";
import { getSupabase } from "@/lib/supabase";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const SITE = "https://activantcapital.com";
const INDEX_URL = `${SITE}/research`;

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

// Parse "Jun 17, 2025" / "June 17, 2025" / "Jun 2025" → YYYY-MM-DD.
function parseDate(text: string): string | null {
  const withDay = text.match(
    /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/i
  );
  if (withDay) {
    const mo = MONTHS[withDay[1].slice(0, 3).toLowerCase()];
    if (mo) return `${withDay[3]}-${mo}-${withDay[2].padStart(2, "0")}`;
  }
  const monthYear = text.match(
    /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{4})\b/i
  );
  if (monthYear) {
    const mo = MONTHS[monthYear[1].slice(0, 3).toLowerCase()];
    if (mo) return `${monthYear[2]}-${mo}-01`;
  }
  return null;
}

function normUrl(u: string): string {
  return u.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/+$/, "").toLowerCase();
}

// Read every article's date from the /research index page → { normalizedUrl: date }.
async function fetchIndexDateMap(): Promise<Map<string, string>> {
  const res = await fetch(INDEX_URL, { headers: { "User-Agent": "ARIA-ingest" } });
  if (!res.ok) throw new Error(`Failed to fetch research index (${res.status})`);
  const $ = cheerio.load(await res.text());

  const map = new Map<string, string>();
  $('a[href*="/research/"]').each((_, el) => {
    let href = ($(el).attr("href") || "").trim();
    if (!href) return;
    if (href.startsWith("/")) href = SITE + href;
    const m = href.match(/^https?:\/\/[^/]*activantcapital\.com\/research\/[^/?#]+/i);
    if (!m) return;
    const key = normUrl(m[0]);
    if (map.has(key)) return;

    // Find the nearest date by widening from the anchor to its card container.
    let scope = $(el);
    let date: string | null = null;
    for (let i = 0; i < 3 && !date; i++) {
      date = parseDate(scope.text());
      if (!date) scope = scope.parent();
    }
    if (date) map.set(key, date);
  });
  return map;
}

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

  const hasDateByUrl = new Map<string, boolean>();
  for (const row of data ?? []) {
    const url = (row as any).article_url as string;
    hasDateByUrl.set(url, (hasDateByUrl.get(url) ?? false) || !!(row as any).published_at);
  }

  let dateMap: Map<string, string>;
  try {
    dateMap = await fetchIndexDateMap();
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502, headers: { "Cache-Control": "no-store" } }
    );
  }

  let urls = [...hasDateByUrl.keys()];
  if (onlyMissing) urls = urls.filter((u) => !hasDateByUrl.get(u));

  let updated = 0;
  let unmatched = 0;
  let failed = 0;
  const unmatchedSample: string[] = [];

  for (const url of urls) {
    const date = dateMap.get(normUrl(url));
    if (!date) {
      unmatched++;
      if (unmatchedSample.length < 10) unmatchedSample.push(url);
      continue;
    }
    const { error: upErr } = await supabase
      .from("research_chunks")
      .update({ published_at: date })
      .eq("article_url", url);
    if (upErr) failed++;
    else updated++;
  }

  return NextResponse.json(
    {
      total_articles: hasDateByUrl.size,
      index_dates_found: dateMap.size,
      targeted: urls.length,
      updated,
      unmatched,
      failed,
      unmatched_sample: unmatchedSample,
      note:
        "Dates are read from the /research index. If unmatched is high, the sample shows stored URLs that didn't line up with the index. Add &all=true to re-date every article.",
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
