import { getSupabase } from "@/lib/supabase";

// Reads dashboard-set overrides from the shared bot_config table. Cached briefly.
const TTL_MS = 30_000;

let modelCache: { at: number; map: Record<string, string> } | null = null;
let promptCache: { at: number; map: Record<string, string> } | null = null;

// Per-bot model override (bot_config key "model_overrides"). Falls back to env, then default.
export async function getActiveModel(bot: string, fallback?: string): Promise<string> {
  const def = (fallback && fallback.trim()) || "anthropic/claude-sonnet-4-5";
  try {
    if (!modelCache || Date.now() - modelCache.at > TTL_MS) {
      const { data } = await getSupabase()
        .from("bot_config")
        .select("value")
        .eq("key", "model_overrides")
        .maybeSingle();
      modelCache = { at: Date.now(), map: ((data as any)?.value ?? {}) as Record<string, string> };
    }
    const v = modelCache.map[bot];
    return typeof v === "string" && v.trim() ? v.trim() : def;
  } catch {
    return def;
  }
}

// Per-bot system-prompt override (bot_config key "prompt_overrides"). Falls back
// to the bot's hardcoded default prompt when no override is set.
export async function getActivePrompt(bot: string, fallback: string): Promise<string> {
  try {
    if (!promptCache || Date.now() - promptCache.at > TTL_MS) {
      const { data } = await getSupabase()
        .from("bot_config")
        .select("value")
        .eq("key", "prompt_overrides")
        .maybeSingle();
      promptCache = { at: Date.now(), map: ((data as any)?.value ?? {}) as Record<string, string> };
    }
    const v = promptCache.map[bot];
    return typeof v === "string" && v.trim() ? v : fallback;
  } catch {
    return fallback;
  }
}
