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
