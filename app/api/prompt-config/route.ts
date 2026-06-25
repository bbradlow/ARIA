import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BOTS = ["ARIA", "APRIL", "ARC"];

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
      /* fall through */
    }
  }
  return false;
}

async function readOverrides(): Promise<Record<string, string>> {
  try {
    const { data } = await getSupabase()
      .from("bot_config")
      .select("value")
      .eq("key", "prompt_overrides")
      .maybeSingle();
    return ((data as any)?.value ?? {}) as Record<string, string>;
  } catch {
    return {};
  }
}

export async function GET(req: NextRequest) {
  if (!(await isAuthorized(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json({ overrides: await readOverrides() }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  if (!(await isAuthorized(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const bot = String(body?.bot ?? "");
  if (!BOTS.includes(bot)) {
    return NextResponse.json({ error: "unknown bot" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const prompt = typeof body?.prompt === "string" ? body.prompt : "";

  const overrides = await readOverrides();
  if (prompt.trim()) overrides[bot] = prompt;
  else delete overrides[bot]; // empty clears the override (back to the bot's default prompt)

  try {
    const { error } = await getSupabase()
      .from("bot_config")
      .upsert({ key: "prompt_overrides", value: overrides, updated_at: new Date().toISOString() }, { onConflict: "key" });
    if (error) throw new Error(error.message);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
  return NextResponse.json({ overrides }, { headers: { "Cache-Control": "no-store" } });
}
