"use client";

import { useEffect, useMemo, useState, type ReactNode, type CSSProperties } from "react";
import { createClient, type Session } from "@supabase/supabase-js";

type Point = { date: string; count: number };
type TypeCount = { type: string; count: number };
type BotData = {
  name: string;
  label: string;
  deployed: boolean;
  headline: { label: string; value: number }[];
  perDay: Point[];
  byType: TypeCount[];
};
type Metrics = { generatedAt: string; windowDays: number; bots: Record<string, BotData> };

const TABS = ["ARIA", "APRIL", "ARC"] as const;

// Activant palette
const INK = "#0c1a2b";       // deep navy
const INK2 = "#13263d";
const PAPER = "#f4f2ec";     // warm off-white
const CARD = "#ffffff";
const LINE = "#e3ddd0";
const ACCENT = "#b08d57";    // muted gold
const ACCENT_INK = "#1f3a5f";// chart navy
const MUTE = "#6b6354";
const SERIF = 'Georgia, "Times New Roman", serif';
const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const supabase = SUPABASE_URL && SUPABASE_ANON ? createClient(SUPABASE_URL, SUPABASE_ANON) : null;

export default function Dashboard() {
  const [token, setToken] = useState("");
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  const [data, setData] = useState<Metrics | null>(null);
  const [active, setActive] = useState<(typeof TABS)[number]>("ARIA");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Resolve auth: ?token= short-circuits; otherwise use a Supabase session.
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("token") ?? "";
    if (t) {
      setToken(t);
      setAuthReady(true);
      return;
    }
    if (!supabase) {
      setAuthReady(true);
      return;
    }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  const authed = !!token || !!session;

  async function loadMetrics() {
    setLoading(true);
    setError(null);
    try {
      const headers: Record<string, string> = {};
      let url = "/api/metrics";
      if (token) url += `?token=${encodeURIComponent(token)}`;
      else if (session) headers["Authorization"] = `Bearer ${session.access_token}`;
      const res = await fetch(url, { headers, cache: "no-store" });
      if (!res.ok) throw new Error(res.status === 401 ? "Not authorized." : `Request failed (${res.status}).`);
      setData((await res.json()) as Metrics);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (authed) loadMetrics();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed, token, session]);

  async function signIn() {
    if (!supabase) return;
    setSigningIn(true);
    setAuthError(null);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (error) setAuthError(error.message);
    setSigningIn(false);
  }

  async function signOut() {
    if (supabase) await supabase.auth.signOut();
    setData(null);
  }

  if (!authReady) {
    return <Shell><div style={{ color: "#cdd6e3", padding: 60 }}>Loading…</div></Shell>;
  }

  // ---- Login gate (no token, no session) ----
  if (!authed) {
    return (
      <Shell>
        <div style={{ maxWidth: 380, margin: "10vh auto 0" }}>
          <div style={{ textAlign: "center", marginBottom: 26 }}>
            <Wordmark light />
            <p style={{ color: "#9fb0c4", fontSize: 13, marginTop: 10, fontFamily: SANS }}>Bot Intelligence Dashboard</p>
          </div>
          <div style={{ background: CARD, borderRadius: 14, padding: 24, boxShadow: "0 12px 40px rgba(0,0,0,0.35)" }}>
            {supabase ? (
              <>
                <label style={lblStyle}>Email</label>
                <input style={inpStyle} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@activantcapital.com" />
                <label style={lblStyle}>Password</label>
                <input
                  style={inpStyle}
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && signIn()}
                  placeholder="••••••••"
                />
                {authError && <div style={{ color: "#b42318", fontSize: 12.5, marginTop: 10 }}>{authError}</div>}
                <button onClick={signIn} disabled={signingIn} style={primaryBtn}>
                  {signingIn ? "Signing in…" : "Sign in"}
                </button>
                <p style={{ color: MUTE, fontSize: 11.5, marginTop: 14, textAlign: "center", fontFamily: SANS }}>
                  Accounts are managed in Supabase Auth.
                </p>
              </>
            ) : (
              <p style={{ color: MUTE, fontSize: 13, fontFamily: SANS }}>
                Sign-in isn&rsquo;t configured. Open this page with <code>?token=YOUR_TOKEN</code> to view metrics.
              </p>
            )}
          </div>
        </div>
      </Shell>
    );
  }

  const bot = data?.bots?.[active];

  return (
    <Shell>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "20px 0 18px", borderBottom: `1px solid rgba(255,255,255,0.08)` }}>
        <Wordmark light />
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span style={{ color: "#8aa", fontSize: 12, fontFamily: SANS }}>
            {data ? `Last ${data.windowDays}d · ${new Date(data.generatedAt).toLocaleString()}` : ""}
          </span>
          <button onClick={loadMetrics} disabled={loading} style={ghostBtn}>{loading ? "…" : "Refresh"}</button>
          {session && <button onClick={signOut} style={ghostBtn}>Sign out</button>}
        </div>
      </header>

      <div style={{ background: PAPER, margin: "0 -24px", padding: "24px", minHeight: "70vh" }}>
        <div style={{ maxWidth: 1040, margin: "0 auto" }}>
          <div style={{ display: "flex", gap: 4, background: "#eae5da", padding: 4, borderRadius: 10, width: "fit-content", marginBottom: 22 }}>
            {TABS.map((t) => {
              const on = t === active;
              const dep = data?.bots?.[t]?.deployed;
              return (
                <button key={t} onClick={() => setActive(t)} style={{
                  padding: "8px 20px", border: "none", borderRadius: 7, fontSize: 13.5, fontWeight: 600, cursor: "pointer",
                  fontFamily: SANS, background: on ? CARD : "transparent", color: on ? INK : MUTE,
                  boxShadow: on ? "0 1px 3px rgba(0,0,0,0.12)" : "none", display: "flex", alignItems: "center", gap: 8,
                }}>
                  {t}
                  <span style={{ width: 7, height: 7, borderRadius: "50%", background: dep ? "#3f7d4e" : "#ccc4b4" }} />
                </button>
              );
            })}
          </div>

          {error && (
            <div style={{ padding: 14, background: "#fdeeee", border: "1px solid #f3c7c7", borderRadius: 8, color: "#b42318", fontSize: 14, marginBottom: 18 }}>{error}</div>
          )}

          {bot && (
            <>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 16 }}>
                <h2 style={{ fontFamily: SERIF, fontSize: 22, color: INK, margin: 0 }}>{bot.name}</h2>
                <span style={{ fontSize: 13, color: MUTE, fontFamily: SANS }}>{bot.label}</span>
                {!bot.deployed && (
                  <span style={{ fontSize: 11.5, color: "#7a5b18", background: "#f7edd6", border: `1px solid ${ACCENT}`, padding: "2px 9px", borderRadius: 999, fontFamily: SANS }}>no data yet</span>
                )}
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(155px, 1fr))", gap: 12 }}>
                {bot.headline.map((h) => (
                  <div key={h.label} style={{ background: CARD, border: `1px solid ${LINE}`, borderRadius: 12, padding: "18px 18px" }}>
                    <div style={{ fontFamily: SERIF, fontSize: 30, fontWeight: 700, color: INK, lineHeight: 1.05 }}>{h.value.toLocaleString()}</div>
                    <div style={{ fontSize: 12, color: MUTE, marginTop: 7, fontFamily: SANS, letterSpacing: 0.2 }}>{h.label}</div>
                  </div>
                ))}
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 16, marginTop: 16 }}>
                <Card title={`Queries per day · last ${data?.windowDays ?? 30} days`}>
                  <BarChart points={bot.perDay} />
                </Card>
                <Card title="Events by type">
                  <TypeBreakdown rows={bot.byType} />
                </Card>
              </div>
            </>
          )}
        </div>
      </div>
    </Shell>
  );
}

function Wordmark({ light }: { light?: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", lineHeight: 1 }}>
      <span style={{ fontFamily: SERIF, fontSize: 22, letterSpacing: 3, color: light ? "#f4f2ec" : INK, fontWeight: 600 }}>ACTIVANT</span>
      <span style={{ fontFamily: SANS, fontSize: 10, letterSpacing: 4, color: ACCENT, marginTop: 3 }}>CAPITAL</span>
    </div>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div style={{ minHeight: "100vh", background: INK, fontFamily: SANS }}>
      <div style={{ maxWidth: 1088, margin: "0 auto", padding: "0 24px" }}>{children}</div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ background: CARD, border: `1px solid ${LINE}`, borderRadius: 12, padding: 18 }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: INK, marginBottom: 14, fontFamily: SANS, letterSpacing: 0.3 }}>{title}</div>
      {children}
    </div>
  );
}

function BarChart({ points }: { points: Point[] }) {
  const max = useMemo(() => Math.max(1, ...points.map((p) => p.count)), [points]);
  const total = points.reduce((s, p) => s + p.count, 0);
  if (total === 0) return <div style={{ color: MUTE, fontSize: 13, padding: "34px 0", textAlign: "center", fontFamily: SANS }}>No activity in this window yet.</div>;
  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 160 }}>
        {points.map((p) => (
          <div key={p.date} title={`${p.date}: ${p.count}`} style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "flex-end", height: "100%" }}>
            <div style={{ height: `${(p.count / max) * 100}%`, minHeight: p.count > 0 ? 3 : 0, background: ACCENT_INK, borderRadius: "2px 2px 0 0", opacity: p.count > 0 ? 1 : 0 }} />
          </div>
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: 11, color: MUTE, fontFamily: SANS }}>
        <span>{points[0]?.date.slice(5)}</span>
        <span>{points[points.length - 1]?.date.slice(5)}</span>
      </div>
    </div>
  );
}

function TypeBreakdown({ rows }: { rows: TypeCount[] }) {
  if (!rows.length) return <div style={{ color: MUTE, fontSize: 13, padding: "34px 0", textAlign: "center", fontFamily: SANS }}>No events yet.</div>;
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
      {rows.map((r) => (
        <div key={r.type}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, color: INK, marginBottom: 4, fontFamily: SANS }}>
            <span>{r.type}</span>
            <span style={{ color: MUTE }}>{r.count.toLocaleString()}</span>
          </div>
          <div style={{ height: 6, background: "#ece6da", borderRadius: 999 }}>
            <div style={{ width: `${(r.count / max) * 100}%`, height: "100%", background: ACCENT, borderRadius: 999 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

const lblStyle: CSSProperties = { display: "block", fontSize: 12, color: MUTE, fontFamily: SANS, marginBottom: 6, marginTop: 12 };
const inpStyle: CSSProperties = { width: "100%", padding: "10px 12px", border: `1px solid ${LINE}`, borderRadius: 8, fontSize: 14, boxSizing: "border-box", fontFamily: SANS };
const primaryBtn: CSSProperties = { width: "100%", marginTop: 18, padding: "11px 16px", background: INK, color: "#f4f2ec", border: "none", borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: SANS };
const ghostBtn: CSSProperties = { padding: "7px 13px", background: "transparent", color: "#cdd6e3", border: "1px solid rgba(255,255,255,0.18)", borderRadius: 8, fontSize: 12.5, cursor: "pointer", fontFamily: SANS };
