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

  return { title, url, text };
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

  const embeddings = await embedTexts(chunks);
  const rows = chunks.map((content, i) => ({
    article_title: article.title,
    article_url: article.url ?? null,
    published_at: article.publishedAt ?? null,
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
