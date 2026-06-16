import { NextRequest } from "next/server";
import crypto from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";
const AFFINITY_MCP_URL = "https://mcp.affinity.co/mcp";
const MCP_BETA = "mcp-client-2025-11-20";
const NO_CACHE = { "Cache-Control": "no-store" };

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function verify(req: NextRequest): boolean {
  const expected = process.env.INGEST_TOKEN;
  if (!expected) return false;
  const provided = req.nextUrl.searchParams.get("token");
  return !!provided && timingSafeEqualStr(provided, expected);
}

/**
 * GET /api/affinity/health?token=INGEST_TOKEN
 * Probe 1: a plain Anthropic call (no MCP) → is ANTHROPIC_API_KEY working?
 * Probe 2: the same call with the Affinity MCP server attached → does the
 *          connector authenticate and expose tools?
 * Compare the two to localize a 500: probe 1 ok + probe 2 failing = Affinity
 * connection/auth problem; both failing = Anthropic key/account problem.
 */
export async function GET(req: NextRequest) {
  if (!verify(req)) return new Response("Forbidden", { status: 403, headers: NO_CACHE });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const result: Record<string, unknown> = {
    has_anthropic_key: !!apiKey,
    has_affinity_token: !!process.env.AFFINITY_MCP_TOKEN,
  };

  if (!apiKey) {
    return Response.json({ ...result, error: "ANTHROPIC_API_KEY is not set" }, { headers: NO_CACHE });
  }

  // Probe 1 — plain call, no MCP.
  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 16,
        messages: [{ role: "user", content: "Reply with the single word OK." }],
      }),
    });
    const body = await r.text();
    result.anthropic_key_status = r.status;
    result.anthropic_key_ok = r.ok;
    if (!r.ok) result.anthropic_key_error = body.slice(0, 500);
  } catch (err) {
    result.anthropic_key_ok = false;
    result.anthropic_key_error = err instanceof Error ? err.message : String(err);
  }

  // Probe 2 — same call with the Affinity MCP server attached.
  try {
    const server: Record<string, unknown> = {
      type: "url",
      url: AFFINITY_MCP_URL,
      name: "affinity",
    };
    if (process.env.AFFINITY_MCP_TOKEN) {
      server.authorization_token = process.env.AFFINITY_MCP_TOKEN;
    }

    const r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": MCP_BETA,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 256,
        messages: [{ role: "user", content: "List the names of the tools you have available." }],
        mcp_servers: [server],
        tools: [{ type: "mcp_toolset", mcp_server_name: "affinity" }],
      }),
    });
    const body = await r.text();
    result.affinity_status = r.status;
    result.affinity_ok = r.ok;
    if (r.ok) {
      try {
        const data = JSON.parse(body) as { content?: { type: string }[] };
        result.affinity_tool_calls_seen = (data.content ?? []).filter(
          (b) => b.type === "mcp_tool_use" || b.type === "mcp_tool_result"
        ).length;
      } catch {}
    } else {
      result.affinity_error = body.slice(0, 500);
    }
  } catch (err) {
    result.affinity_ok = false;
    result.affinity_error = err instanceof Error ? err.message : String(err);
  }

  return Response.json(result, { headers: NO_CACHE });
}
