import { getSupabase } from "@/lib/supabase";

/**
 * Fire-and-forget event logging into the shared `bot_events` table. Every bot
 * (ARIA, APRIL, ARC) writes here tagged with its name; the dashboard reads and
 * aggregates across all three. Never throws — metrics must not break the bot.
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
    await supabase.from("bot_events").insert({
      bot,
      event_type: eventType,
      user_id: opts?.userId ?? null,
      metadata: opts?.metadata ?? null,
    });
  } catch (err) {
    console.error("logEvent failed:", err);
  }
}
