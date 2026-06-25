import { getSupabase } from "@/lib/supabase";

/**
 * Event logging into the shared `bot_events` table. Every bot (ARIA, APRIL,
 * ARC) writes here tagged with its name; the dashboard reads and aggregates
 * across all three. Never throws — metrics must not break the bot. Callers
 * should `await` this so the write completes before the function freezes.
 *
 * Table (run once in Supabase):
 *   create table if not exists bot_events (
 *     id bigint generated always as identity primary key,
 *     bot text not null,
 *     event_type text not null,
 *     user_id text,
 *     metadata jsonb,
 *     created_at timestamptz not null default now()
 *   );
 *   create index if not exists bot_events_bot_created_idx
 *     on bot_events (bot, created_at desc);
 */
export async function logEvent(
  bot: string,
  eventType: string,
  opts?: { userId?: string | null; metadata?: Record<string, unknown> | null }
): Promise<void> {
  try {
    const supabase = getSupabase();
    const { error } = await supabase.from("bot_events").insert({
      bot,
      event_type: eventType,
      user_id: opts?.userId ?? null,
      metadata: opts?.metadata ?? null,
    });
    if (error) console.error("logEvent insert error:", error.message);
  } catch (err) {
    console.error("logEvent failed:", err);
  }
}

/**
 * Log token usage from an OpenRouter response so the dashboard can estimate
 * model cost. Records the model and token counts; cost is computed centrally
 * in the metrics API from a price table.
 */
export async function logLlmUsage(bot: string, model: string, apiJson: unknown): Promise<void> {
  const u = (apiJson as { usage?: { prompt_tokens?: number; completion_tokens?: number } })?.usage ?? {};
  await logEvent(bot, "llm_usage", {
    metadata: {
      model,
      prompt_tokens: Number(u.prompt_tokens ?? 0),
      completion_tokens: Number(u.completion_tokens ?? 0),
    },
  });
}
