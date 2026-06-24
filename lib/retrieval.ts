import { getSupabase } from "@/lib/supabase";
import { embedText } from "@/lib/embeddings";

export interface RetrievedChunk {
  content: string;
  article_title: string;
  article_url: string | null;
  similarity: number;
}

/** Embed the question and return the most similar research chunks via pgvector. */
export async function retrieve(question: string, matchCount = 6): Promise<RetrievedChunk[]> {
  const embedding = await embedText(question);
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc("match_research_chunks", {
    query_embedding: embedding,
    match_count: matchCount,
  });
  if (error) throw error;
  return (data ?? []) as RetrievedChunk[];
}

/** Fetch stored chunks for one specific article (by URL, or title as fallback). */
export async function getArticleChunks(
  article: { article_url: string | null; article_title: string },
  limit = 6
): Promise<RetrievedChunk[]> {
  const supabase = getSupabase();
  let query = supabase
    .from("research_chunks")
    .select("content, article_title, article_url");
  query = article.article_url
    ? query.eq("article_url", article.article_url)
    : query.eq("article_title", article.article_title);
  const { data, error } = await query.limit(limit);
  if (error) throw error;
  return ((data ?? []) as any[]).map((r) => ({
    content: r.content,
    article_title: r.article_title,
    article_url: r.article_url,
    similarity: 1,
  }));
}

export interface ArticleMeta {
  article_title: string;
  article_url: string | null;
  published_at: string | null;
}

/**
 * Distinct list of every ingested article with its publication date, sorted
 * newest first (undated last). Lets the QA layer answer recency/listing/count
 * questions that pure semantic search can't (e.g. "what's the latest article").
 */
export async function listArticleIndex(): Promise<ArticleMeta[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("research_chunks")
    .select("article_title, article_url, published_at");
  if (error) throw error;

  const byKey = new Map<string, ArticleMeta>();
  for (const r of (data ?? []) as ArticleMeta[]) {
    const key = r.article_url ?? r.article_title;
    if (!byKey.has(key)) byKey.set(key, r);
  }

  return [...byKey.values()].sort((a, b) => {
    if (!a.published_at && !b.published_at) return 0;
    if (!a.published_at) return 1; // undated last
    if (!b.published_at) return -1;
    return b.published_at.localeCompare(a.published_at); // newest first
  });
}
