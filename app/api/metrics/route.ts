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
  let events: { bot: string; event_type: string; created_at: string }[] = [];
  try {
    const { data } = await supabase
      .from("bot_events")
      .select("bot, event_type, created_at")
      .gte("created_at", since.toISOString())
      .order("created_at", { ascending: false })
      .limit(50000);
    events = (data as any[]) ?? [];
  } catch {
    events = [];
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
