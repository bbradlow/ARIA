import * as cheerio from "cheerio";
import { getSupabase } from "@/lib/supabase";
import { embedTexts } from "@/lib/embeddings";
import { chunkText } from "@/lib/chunk";

const SITE = "https://activantcapital.com";
const INDEX_URL = `${SITE}/research`;

export interface ArticleInput {
  title: string;
  url?: string | null;
  publishedAt?: string | null;
  text: string;
}

/** Discover every article URL from the research index page. */
export async function listArticleUrls(): Promise<string[]> {
  const res = await fetch(INDEX_URL, { headers: { "User-Agent": "ARIA-ingest" } });
  if (!res.ok) throw new Error(`Failed to fetch research index (${res.status})`);
  const html = await res.text();
  const $ = cheerio.load(html);

  const urls = new Set<string>();
  $('a[href*="/research/"]').each((_, el) => {
    let href = ($(el).attr("href") || "").trim();
    if (!href) return;
    if (href.startsWith("/")) href = SITE + href;
    // Keep only article pages: /research/<slug>, not the bare index.
    const m = href.match(
      /^https?:\/\/[^/]*activantcapital\.com\/research\/[^/?#]+/i
    );
    if (m) urls.add(m[0]);
  });
  return [...urls];
}

const MONTHS: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
  july: "07", august: "08", september: "09", october: "10", november: "11", december: "12",
};

/**
 * Pull the publication date from an article's visible "Published" field
 * (e.g. "Published June 2026" or "Published June 12, 2026"). Activant pages are
 * month-level, so a missing day defaults to the 1st. Returns ISO YYYY-MM-DD or null.
 */
function extractPublishedDate(text: string): string | null {
  const m = text.match(
    /Published[\s\S]{0,40}?\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(?:(\d{1,2}),\s*)?(\d{4})\b/i
  );
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  if (!month) return null;
  const day = (m[2] ?? "1").padStart(2, "0");
  return `${m[3]}-${month}-${day}`;
}

const MONTHS_ABBR: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

// Parse the index's date format: "Jun 17, 2025" / "June 17, 2025" / "Jun 2025".
function parseIndexDate(text: string): string | null {
  const withDay = text.match(
    /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/i
  );
  if (withDay) {
    const mo = MONTHS_ABBR[withDay[1].slice(0, 3).toLowerCase()];
    if (mo) return `${withDay[3]}-${mo}-${withDay[2].padStart(2, "0")}`;
  }
  const monthYear = text.match(
    /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{4})\b/i
  );
  if (monthYear) {
    const mo = MONTHS_ABBR[monthYear[1].slice(0, 3).toLowerCase()];
    if (mo) return `${monthYear[2]}-${mo}-01`;
  }
  return null;
}

function normUrl(u: string): string {
  return u.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/+$/, "").toLowerCase();
}

// Build { normalizedUrl: date } from the /research index page, where each
// article is listed with its publication date.
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
    let scope = $(el);
    let date: string | null = null;
    for (let i = 0; i < 3 && !date; i++) {
      date = parseIndexDate(scope.text());
      if (!date) scope = scope.parent();
    }
    if (date) map.set(key, date);
  });
  return map;
}

// Short-lived cache so a burst of articles in one run shares a single fetch.
let indexDateCache: { at: number; map: Map<string, string> } | null = null;
const INDEX_CACHE_MS = 5 * 60 * 1000;

async function lookupPublishedDate(url: string): Promise<string | null> {
  try {
    if (!indexDateCache || Date.now() - indexDateCache.at > INDEX_CACHE_MS) {
      indexDateCache = { at: Date.now(), map: await fetchIndexDateMap() };
    }
    return indexDateCache.map.get(normUrl(url)) ?? null;
  } catch {
    return null;
  }
}

/** Fetch a single article page and extract its title and body text. */
export async function fetchArticle(url: string): Promise<ArticleInput> {
  const res = await fetch(url, { headers: { "User-Agent": "ARIA-ingest" } });
  if (!res.ok) throw new Error(`Failed to fetch ${url} (${res.status})`);
  const html = await res.text();
  const $ = cheerio.load(html);
  $("script, style, head, nav, footer, header, noscript").remove();

  const title =
    $('meta[property="og:title"]').attr("content")?.trim() ||
    $("h1").first().text().trim() ||
    $("title").text().trim() ||
    url;

  const text = ($("main").text() || $("body").text())
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const publishedAt = extractPublishedDate(text);

  return { title, url, publishedAt, text };
}

/** Has this article URL already been ingested? */
export async function isArticleIngested(url: string): Promise<boolean> {
  const supabase = getSupabase();
  const { count, error } = await supabase
    .from("research_chunks")
    .select("id", { count: "exact", head: true })
    .eq("article_url", url);
  if (error) throw error;
  return (count ?? 0) > 0;
}

/**
 * Chunk, embed, and store one article. Idempotent: replaces any existing chunks
 * for the same URL. Returns the number of chunks stored.
 */
export async function ingestArticle(article: ArticleInput): Promise<number> {
  const supabase = getSupabase();
  const chunks = chunkText(article.text);
  if (chunks.length === 0) return 0;

  // Date the article automatically: use the date from the page if we found one,
  // otherwise look it up on the /research index by URL. Runs on every ingest
  // (including the newsletter inbound path), so new research is dated on arrival.
  let publishedAt = article.publishedAt ?? null;
  if (!publishedAt && article.url) {
    publishedAt = await lookupPublishedDate(article.url);
  }

  const embeddings = await embedTexts(chunks);
  const rows = chunks.map((content, i) => ({
    article_title: article.title,
    article_url: article.url ?? null,
    published_at: publishedAt,
    content,
    embedding: embeddings[i],
  }));

  // Keep it idempotent: clear prior chunks for this URL before inserting.
  if (article.url) {
    await supabase.from("research_chunks").delete().eq("article_url", article.url);
  }
  const { error } = await supabase.from("research_chunks").insert(rows);
  if (error) throw error;
  return rows.length;
}
