import * as cheerio from "cheerio";

const BASE = "https://activantcapital.com";
const LISTING_URL = `${BASE}/research`;
const UA = "ActivantResearchBot/1.0 (+https://activantcapital.com)";

export interface ArticleRef {
  url: string;
  slug: string;
}

export interface ArticleContent {
  title: string;
  bodyText: string;
}

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html" },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  return res.text();
}

/**
 * Scrapes the research listing page and returns every article reference.
 *
 * Articles live at `/research/<slug>`. We deliberately key off that URL pattern
 * rather than the brittle positional XPath from the spec
 * (`/html/body/div/main/div[3]/.../div`), which would break on any layout change.
 * Selecting by URL shape is far more durable: as long as articles are linked as
 * `/research/<slug>`, this keeps working.
 */
export async function scrapeArticleList(): Promise<ArticleRef[]> {
  const html = await fetchHtml(LISTING_URL);
  const $ = cheerio.load(html);

  const seen = new Set<string>();
  const articles: ArticleRef[] = [];

  $('a[href*="/research/"]').each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;

    let parsed: URL;
    try {
      parsed = new URL(href, BASE);
    } catch {
      return;
    }

    if (parsed.hostname !== "activantcapital.com") return;

    // Match /research/<slug> with a non-empty slug; exclude the listing itself.
    const match = parsed.pathname.match(/^\/research\/([^/]+)\/?$/);
    if (!match) return;

    const slug = match[1];
    const clean = `${BASE}/research/${slug}`;
    if (seen.has(clean)) return;
    seen.add(clean);
    articles.push({ url: clean, slug });
  });

  return articles;
}

/** Strips the trailing " — Activant" suffix the site appends to <title>. */
function cleanTitle(raw: string): string {
  return raw.replace(/\s*[—–|-]\s*Activant.*$/i, "").trim();
}

/**
 * Fetches a single article page and extracts its title and main body text.
 *
 * Strategy: drop non-content elements (nav/header/footer/scripts/etc.), then
 * pull text from <main> (the site uses a top-level <main>), falling back to
 * <article> then <body>. Whitespace is collapsed and the result is capped so
 * the summarization prompt stays within a sane token budget.
 */
export async function scrapeArticleContent(url: string): Promise<ArticleContent> {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const rawTitle =
    $('meta[property="og:title"]').attr("content") ||
    $("title").first().text() ||
    $("h1").first().text() ||
    url;
  const title = cleanTitle(rawTitle);

  // Remove obvious boilerplate / non-prose before extracting text.
  $("script, style, noscript, nav, header, footer, svg, form, iframe").remove();

  let container = $("main").first();
  if (container.length === 0) container = $("article").first();
  if (container.length === 0) container = $("body");

  const bodyText = container
    .text()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 16000); // ~4k tokens: ample for a 3-5 sentence summary.

  return { title, bodyText };
}
