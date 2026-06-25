import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MODES = ["off", "open", "passphrase", "allowlist"];
const DEFAULT = { mode: "off", passphrase: "", allowlist: [] as string[] };

// Same auth as /api/metrics: a valid Supabase session (Bearer) or the token.
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

async function readConfig() {
  try {
    const { data } = await getSupabase()
      .from("bot_config")
      .select("value")
      .eq("key", "arc_access")
      .maybeSingle();
    const v = (data as any)?.value ?? {};
    return {
      mode: MODES.includes(v.mode) ? v.mode : "off",
      passphrase: typeof v.passphrase === "string" ? v.passphrase : "",
      allowlist: Array.isArray(v.allowlist) ? v.allowlist.map((s: unknown) => String(s)) : [],
    };
  } catch {
    return DEFAULT;
  }
}

export async function GET(req: NextRequest) {
  if (!(await isAuthorized(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json({ config: await readConfig() }, { headers: { "Cache-Control": "no-store" } });
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
  const value = {
    mode: MODES.includes(body?.mode) ? body.mode : "off",
    passphrase: typeof body?.passphrase === "string" ? body.passphrase : "",
    allowlist: Array.isArray(body?.allowlist)
      ? body.allowlist.map((s: unknown) => String(s).trim()).filter(Boolean)
      : [],
  };
  try {
    const { error } = await getSupabase()
      .from("bot_config")
      .upsert({ key: "arc_access", value, updated_at: new Date().toISOString() }, { onConflict: "key" });
    if (error) throw new Error(error.message);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
  return NextResponse.json({ config: value }, { headers: { "Cache-Control": "no-store" } });
}
