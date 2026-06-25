import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Cache the catalog in memory so repeated dashboard loads don't re-hit OpenRouter.
let cache: { at: number; models: { id: string; name: string }[] } | null = null;
const TTL_MS = 10 * 60 * 1000;

export async function GET() {
  if (cache && Date.now() - cache.at < TTL_MS) {
    return NextResponse.json({ models: cache.models }, { headers: { "Cache-Control": "no-store" } });
  }
  try {
    const headers: Record<string, string> = {};
    // Auth is optional for the public model list, but include the key if present.
    if (process.env.OPENROUTER_API_KEY) headers.Authorization = `Bearer ${process.env.OPENROUTER_API_KEY}`;
    const res = await fetch("https://openrouter.ai/api/v1/models?sort=top-weekly", { headers });
    if (!res.ok) throw new Error(`OpenRouter models request failed (${res.status})`);
    const data = await res.json();
    const models = ((data?.data ?? []) as any[])
      .map((m) => ({ id: String(m?.id ?? ""), name: String(m?.name ?? m?.id ?? "") }))
      .filter((m) => m.id);
    cache = { at: Date.now(), models };
    return NextResponse.json({ models }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    // On failure return empty; the client falls back to its built-in shortlist.
    return NextResponse.json(
      { models: [], error: e instanceof Error ? e.message : String(e) },
      { headers: { "Cache-Control": "no-store" } }
    );
  }
}
