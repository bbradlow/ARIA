import { getSupabase } from "@/lib/supabase";

// Reads per-bot model overrides set from the ARIA dashboard (bot_config key
// "model_overrides", value like {"ARIA":"...","APRIL":"...","ARC":"..."}).
// Falls back to the provided env value, then to a sane default. Cached briefly.
let cache: { at: number; map: Record<string, string> } | null = null;
const TTL_MS = 30_000;

export async function getActiveModel(bot: string, fallback?: string): Promise<string> {
  const def = (fallback && fallback.trim()) || "anthropic/claude-sonnet-4-5";
  try {
    if (!cache || Date.now() - cache.at > TTL_MS) {
      const { data } = await getSupabase()
        .from("bot_config")
        .select("value")
        .eq("key", "model_overrides")
        .maybeSingle();
      cache = { at: Date.now(), map: ((data as any)?.value ?? {}) as Record<string, string> };
    }
    const v = cache.map[bot];
    return typeof v === "string" && v.trim() ? v.trim() : def;
  } catch {
    return def;
  }
}
