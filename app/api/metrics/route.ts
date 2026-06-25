import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BOTS = ["ARIA", "APRIL", "ARC"] as const;
type Bot = (typeof BOTS)[number];

// Which event types count as a "query" (the headline activity metric) per bot.
const QUERY_EVENTS: Record<Bot, Set<string>> = {
  ARIA: new Set(["research_query"]),
  APRIL: new Set(["affinity_query", "afflat", "list"]),
  ARC: new Set(["query", "research_query"]),
};

const WINDOW_DAYS = 30;

// Fallback prices, USD per 1M tokens, used only when the live OpenRouter
// catalog can't be reached or doesn't list a model. Live prices take priority.
const PRICES: Record<string, { in: number; out: number }> = {
  "anthropic/claude-sonnet-4-5": { in: 3, out: 15 },
  "anthropic/claude-3.5-sonnet": { in: 3, out: 15 },
  "anthropic/claude-3-5-sonnet": { in: 3, out: 15 },
  "anthropic/claude-haiku-4-5": { in: 1, out: 5 },
  "anthropic/claude-3.5-haiku": { in: 0.8, out: 4 },
  "anthropic/claude-opus-4": { in: 15, out: 75 },
  "openai/gpt-4o": { in: 2.5, out: 10 },
  "openai/gpt-4o-mini": { in: 0.15, out: 0.6 },
  "openai/gpt-4.1": { in: 2, out: 8 },
  "google/gemini-2.5-pro": { in: 1.25, out: 10 },
  "google/gemini-2.5-flash": { in: 0.3, out: 2.5 },
};
const DEFAULT_PRICE = { in: 3, out: 15 };

// Live per-model pricing pulled from the OpenRouter catalog (USD per 1M tokens),
// cached in-process so the dashboard doesn't refetch on every load. Keeps cost
// accurate automatically as rates change or the model is switched.
let livePriceCache: { at: number; map: Map<string, { in: number; out: number }> } | null = null;
const PRICE_TTL_MS = 10 * 60 * 1000;

async function getLivePrices(): Promise<Map<string, { in: number; out: number }>> {
  if (livePriceCache && Date.now() - livePriceCache.at < PRICE_TTL_MS) return livePriceCache.map;
  const map = new Map<string, { in: number; out: number }>();
  try {
    const headers: Record<string, string> = {};
    if (process.env.OPENROUTER_API_KEY) headers.Authorization = `Bearer ${process.env.OPENROUTER_API_KEY}`;
    const res = await fetch("https://openrouter.ai/api/v1/models", { headers });
    if (res.ok) {
      const data = await res.json();
      for (const m of ((data?.data ?? []) as any[])) {
        const id = String(m?.id ?? "").toLowerCase();
        if (!id) continue;
        const p = m?.pricing ?? {};
        // OpenRouter prices are USD per token; convert to per 1M to match PRICES.
        map.set(id, { in: Number(p.prompt ?? 0) * 1e6, out: Number(p.completion ?? 0) * 1e6 });
      }
    }
  } catch {
    /* fall back to static PRICES */
  }
  livePriceCache = { at: Date.now(), map };
  return map;
}

function eventCost(meta: any, live: Map<string, { in: number; out: number }>): number {
  if (!meta) return 0;
  const model = String(meta.model ?? "").toLowerCase();
  // Live catalog first, then static fallback, then default.
  const p = live.get(model) ?? PRICES[model] ?? DEFAULT_PRICE;
  const pt = Number(meta.prompt_tokens ?? 0);
  const ct = Number(meta.completion_tokens ?? 0);
  return (pt / 1e6) * p.in + (ct / 1e6) * p.out;
}

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function lastNDays(n: number): string[] {
  const out: string[] = [];
  const today = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    out.push(dayKey(d));
  }
  return out;
}

async function tableCount(
  supabase: ReturnType<typeof getSupabase>,
  table: string,
  filter?: (q: any) => any
): Promise<number> {
  try {
    let q = supabase.from(table).select("*", { count: "exact", head: true });
    if (filter) q = filter(q);
    const { count, error } = await q;
    if (error) return 0;
    return count ?? 0;
  } catch {
    return 0;
  }
}

async function distinctArticleCount(supabase: ReturnType<typeof getSupabase>): Promise<number> {
  try {
    const { data, error } = await supabase
      .from("research_chunks")
      .select("article_url, article_title");
    if (error || !data) return 0;
    const seen = new Set<string>();
    for (const r of data as any[]) seen.add(r.article_url ?? r.article_title ?? "");
    seen.delete("");
    return seen.size;
  } catch {
    return 0;
  }
}

// Authorized if EITHER a valid Supabase session (Authorization: Bearer <jwt>)
// OR the metrics token (?token=) is provided. The token is a fallback so the
// dashboard is never locked out if auth is misconfigured.
async function isAuthorized(req: NextRequest): Promise<boolean> {
  const token = req.nextUrl.searchParams.get("token");
  const expected = process.env.METRICS_TOKEN || process.env.INGEST_TOKEN;
  if (expected && token === expected) return true;

  const auth = req.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m) {
    try {
      const { data, error } = await getSupabase().auth.getUser(m[1]);
      if (!error && data?.user) return true;
    } catch {
      // fall through to unauthorized
    }
  }
  return false;
}

export async function GET(req: NextRequest) {
  if (!(await isAuthorized(req))) {
    return NextResponse.json(
      { error: "unauthorized" },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
  }

  const supabase = getSupabase();
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - WINDOW_DAYS);
  const today = dayKey(new Date());
  const days = lastNDays(WINDOW_DAYS);

  // Pull the event window once, then aggregate per bot in memory.
  let events: { bot: string; event_type: string; created_at: string; metadata: any }[] = [];
  try {
    const { data } = await supabase
      .from("bot_events")
      .select("bot, event_type, created_at, metadata")
      .gte("created_at", since.toISOString())
      .order("created_at", { ascending: false })
      .limit(50000);
    events = (data as any[]) ?? [];
  } catch {
    events = [];
  }

  // Cost + current model from the FULL llm_usage history, paginated. A single
  // .limit() is silently capped by the server row limit, which undercounts the
  // total; .range() pagination bypasses that so all-time is complete and always
  // >= the 30-day figure. We derive both windows and the latest model here.
  const usageAgg: Record<string, { costAll: number; cost30d: number; latestMs: number; model: string | null }> = {
    ARIA: { costAll: 0, cost30d: 0, latestMs: 0, model: null },
    APRIL: { costAll: 0, cost30d: 0, latestMs: 0, model: null },
    ARC: { costAll: 0, cost30d: 0, latestMs: 0, model: null },
  };
  const sinceMs = since.getTime();
  const livePrices = await getLivePrices();
  try {
    const pageSize = 1000;
    for (let from = 0; from < 1_000_000; from += pageSize) {
      const { data, error } = await supabase
        .from("bot_events")
        .select("bot, metadata, created_at")
        .eq("event_type", "llm_usage")
        .order("created_at", { ascending: true })
        .range(from, from + pageSize - 1);
      if (error || !data || data.length === 0) break;
      for (const r of data as any[]) {
        const agg = usageAgg[r.bot as string];
        if (!agg) continue;
        const c = eventCost(r.metadata, livePrices);
        agg.costAll += c;
        const ms = new Date(r.created_at).getTime();
        if (ms >= sinceMs) agg.cost30d += c;
        if (ms >= agg.latestMs) {
          agg.latestMs = ms;
          if (r.metadata?.model) agg.model = String(r.metadata.model);
        }
      }
      if (data.length < pageSize) break;
    }
  } catch {
    /* leave zeros */
  }

  const [subscribers, channels, articles] = await Promise.all([
    tableCount(supabase, "subscribers"),
    tableCount(supabase, "channels", (q) => q.eq("active", true)),
    distinctArticleCount(supabase),
  ]);

  function aggregate(bot: Bot) {
    const rows = events.filter((e) => e.bot === bot);
    const queryTypes = QUERY_EVENTS[bot];

    const byTypeMap = new Map<string, number>();
    const perDayMap = new Map<string, number>();
    let queries30d = 0;
    let queriesToday = 0;

    for (const r of rows) {
      byTypeMap.set(r.event_type, (byTypeMap.get(r.event_type) ?? 0) + 1);
      if (queryTypes.has(r.event_type)) {
        const k = (r.created_at || "").slice(0, 10);
        perDayMap.set(k, (perDayMap.get(k) ?? 0) + 1);
        queries30d++;
        if (k === today) queriesToday++;
      }
    }

    const perDay = days.map((d) => ({ date: d, count: perDayMap.get(d) ?? 0 }));
    const byType = [...byTypeMap.entries()]
      .map(([type, count]) => ({ type, count }))
      .filter((t) => t.type !== "llm_usage")
      .sort((a, b) => b.count - a.count);
    const totalEvents = rows.length;

    return { perDay, byType, queries30d, queriesToday, totalEvents };
  }

  const ariaAgg = aggregate("ARIA");
  const aprilAgg = aggregate("APRIL");
  const arcAgg = aggregate("ARC");

  const aria = {
    name: "ARIA",
    label: "Research & Investment",
    deployed: true,
    model: usageAgg.ARIA.model || process.env.QA_MODEL?.trim() || "anthropic/claude-sonnet-4-5",
    cost30d: usageAgg.ARIA.cost30d,
    costAllTime: usageAgg.ARIA.costAll,
    headline: [
      { label: "Subscribed users", value: subscribers },
      { label: "Active channels", value: channels },
      { label: "Articles in library", value: articles },
      { label: "Research queries (30d)", value: ariaAgg.queries30d },
      { label: "Queries today", value: ariaAgg.queriesToday },
    ],
    perDay: ariaAgg.perDay,
    byType: ariaAgg.byType,
  };

  const april = {
    name: "APRIL",
    label: "Affinity Pipeline",
    deployed: aprilAgg.totalEvents > 0,
    model: usageAgg.APRIL.model || "—",
    cost30d: usageAgg.APRIL.cost30d,
    costAllTime: usageAgg.APRIL.costAll,
    headline: [
      { label: "Affinity queries (30d)", value: aprilAgg.queries30d },
      { label: "Queries today", value: aprilAgg.queriesToday },
      { label: "Total events (30d)", value: aprilAgg.totalEvents },
    ],
    perDay: aprilAgg.perDay,
    byType: aprilAgg.byType,
  };

  const arc = {
    name: "ARC",
    label: "Public Research (Slack + WhatsApp)",
    deployed: arcAgg.totalEvents > 0,
    model: usageAgg.ARC.model || "—",
    cost30d: usageAgg.ARC.cost30d,
    costAllTime: usageAgg.ARC.costAll,
    headline: [
      { label: "Queries (30d)", value: arcAgg.queries30d },
      { label: "Queries today", value: arcAgg.queriesToday },
      { label: "Total events (30d)", value: arcAgg.totalEvents },
    ],
    perDay: arcAgg.perDay,
    byType: arcAgg.byType,
  };

  return NextResponse.json(
    { generatedAt: new Date().toISOString(), windowDays: WINDOW_DAYS, bots: { ARIA: aria, APRIL: april, ARC: arc } },
    { headers: { "Cache-Control": "no-store" } }
  );
}
