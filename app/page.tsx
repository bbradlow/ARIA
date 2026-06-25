"use client";

import { useEffect, useMemo, useState, type ReactNode, type CSSProperties } from "react";
import { createClient, type Session } from "@supabase/supabase-js";

type Point = { date: string; count: number };
type TypeCount = { type: string; count: number };
type BotData = {
  name: string;
  label: string;
  deployed: boolean;
  model: string;
  cost30d: number;
  headline: { label: string; value: number }[];
  perDay: Point[];
  byType: TypeCount[];
};
type Metrics = { generatedAt: string; windowDays: number; bots: Record<string, BotData> };

const TABS = ["ARIA", "APRIL", "ARC"] as const;

// ── Edit this to change the heading shown at the top of the dashboard ──
const DASHBOARD_TITLE = "Bot Metrics";

const ACCENT = "#2f6feb";
const INK = "#0f1222";
const MUTE = "#6b7280";
const LINE = "#e6e8ee";
const BG = "#f6f7f9";

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
    return <Shell><div style={{ color: MUTE, padding: 60 }}>Loading…</div></Shell>;
  }

  // ---- Login gate ----
  if (!authed) {
    return (
      <Shell>
        <div style={{ maxWidth: 380, margin: "12vh auto 0", textAlign: "center" }}>
          <h1 style={{ fontSize: 22, color: INK, marginBottom: 6 }}>{DASHBOARD_TITLE}</h1>
          <p style={{ color: MUTE, marginBottom: 22, fontSize: 13 }}>Sign in to view the dashboard.</p>
          <div style={{ background: "#fff", border: `1px solid ${LINE}`, borderRadius: 12, padding: 22, textAlign: "left" }}>
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
              </>
            ) : (
              <p style={{ color: MUTE, fontSize: 13 }}>
                Sign-in isn&rsquo;t configured yet. Set <code>NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
                <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code> in this project to enable login.
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
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 22, color: INK, margin: 0 }}>{DASHBOARD_TITLE}</h1>
          <p style={{ color: MUTE, margin: "4px 0 0", fontSize: 13 }}>
            {data ? `Last ${data.windowDays} days · updated ${new Date(data.generatedAt).toLocaleString()}` : "Loading…"}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={loadMetrics} disabled={loading} style={ghostBtn}>{loading ? "Refreshing…" : "Refresh"}</button>
          {session && <button onClick={signOut} style={ghostBtn}>Sign out</button>}
        </div>
      </div>

      <div style={{ display: "flex", gap: 4, background: "#eef0f4", padding: 4, borderRadius: 10, width: "fit-content", marginTop: 18 }}>
        {TABS.map((t) => {
          const on = t === active;
          const dep = data?.bots?.[t]?.deployed;
          return (
            <button key={t} onClick={() => setActive(t)} style={{
              padding: "8px 18px", border: "none", borderRadius: 7, fontSize: 14, fontWeight: 600, cursor: "pointer",
              background: on ? "#fff" : "transparent", color: on ? INK : MUTE,
              boxShadow: on ? "0 1px 2px rgba(0,0,0,0.08)" : "none", display: "flex", alignItems: "center", gap: 7,
            }}>
              {t}
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: dep ? "#22c55e" : "#cbd2dd" }} />
            </button>
          );
        })}
      </div>

      {error && (
        <div style={{ marginTop: 20, padding: 14, background: "#fff4f4", border: "1px solid #ffd5d5", borderRadius: 8, color: "#b42318", fontSize: 14 }}>{error}</div>
      )}

      {bot && (
        <div style={{ marginTop: 22 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
            <h2 style={{ fontSize: 17, color: INK, margin: 0 }}>{bot.name}</h2>
            <span style={{ fontSize: 13, color: MUTE }}>{bot.label}</span>
            {!bot.deployed && (
              <span style={{ fontSize: 12, color: "#92690b", background: "#fff7e6", border: "1px solid #ffe3a3", padding: "2px 8px", borderRadius: 999 }}>no data yet</span>
            )}
          </div>

          {active === "ARC" && <ArcControls token={token} session={session} />}

          <div style={{ background: "#fff", border: `1px solid ${LINE}`, borderRadius: 12, padding: "16px 18px", marginBottom: 12, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
            <div>
              <div style={{ fontSize: 28, fontWeight: 700, color: INK, lineHeight: 1.1 }}>
                {bot.cost30d < 0.01 ? `$${bot.cost30d.toFixed(4)}` : `$${bot.cost30d.toFixed(2)}`}
              </div>
              <div style={{ fontSize: 12.5, color: MUTE, marginTop: 6 }}>Estimated model cost · last 30 days</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 11, color: MUTE, textTransform: "uppercase", letterSpacing: 0.5 }}>Model in use</div>
              <div style={{ fontSize: 14, color: INK, fontWeight: 600, marginTop: 4, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>{bot.model}</div>
            </div>
          </div>

          <ModelControl bot={bot.name} token={token} session={session} displayedModel={bot.model} />

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
            {bot.headline.map((h) => (
              <div key={h.label} style={{ background: "#fff", border: `1px solid ${LINE}`, borderRadius: 12, padding: "16px 18px" }}>
                <div style={{ fontSize: 28, fontWeight: 700, color: INK, lineHeight: 1.1 }}>{h.value.toLocaleString()}</div>
                <div style={{ fontSize: 12.5, color: MUTE, marginTop: 6 }}>{h.label}</div>
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
        </div>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div style={{ minHeight: "100vh", background: BG, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif" }}>
      <div style={{ maxWidth: 1040, margin: "0 auto", padding: "32px 24px 64px" }}>{children}</div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ background: "#fff", border: `1px solid ${LINE}`, borderRadius: 12, padding: 18 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: INK, marginBottom: 14 }}>{title}</div>
      {children}
    </div>
  );
}

function BarChart({ points }: { points: Point[] }) {
  const max = useMemo(() => Math.max(1, ...points.map((p) => p.count)), [points]);
  const total = points.reduce((s, p) => s + p.count, 0);
  if (total === 0) return <div style={{ color: MUTE, fontSize: 13, padding: "30px 0", textAlign: "center" }}>No activity in this window yet.</div>;
  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 160 }}>
        {points.map((p) => (
          <div key={p.date} title={`${p.date}: ${p.count}`} style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "flex-end", height: "100%" }}>
            <div style={{ height: `${(p.count / max) * 100}%`, minHeight: p.count > 0 ? 3 : 0, background: ACCENT, borderRadius: "3px 3px 0 0", opacity: p.count > 0 ? 1 : 0 }} />
          </div>
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: 11, color: MUTE }}>
        <span>{points[0]?.date.slice(5)}</span>
        <span>{points[points.length - 1]?.date.slice(5)}</span>
      </div>
    </div>
  );
}

function TypeBreakdown({ rows }: { rows: TypeCount[] }) {
  if (!rows.length) return <div style={{ color: MUTE, fontSize: 13, padding: "30px 0", textAlign: "center" }}>No events yet.</div>;
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {rows.map((r) => (
        <div key={r.type}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, color: INK, marginBottom: 4 }}>
            <span>{r.type}</span>
            <span style={{ color: MUTE }}>{r.count.toLocaleString()}</span>
          </div>
          <div style={{ height: 6, background: "#eef0f4", borderRadius: 999 }}>
            <div style={{ width: `${(r.count / max) * 100}%`, height: "100%", background: ACCENT, borderRadius: 999 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

type ModelOpt = { id: string; name: string; free: boolean; inPerM: number; outPerM: number };

function ModelControl({
  bot,
  token,
  session,
  displayedModel,
}: {
  bot: string;
  token: string;
  session: Session | null;
  displayedModel: string;
}) {
  const [value, setValue] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [models, setModels] = useState<ModelOpt[]>([]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("all");
  const [freeOnly, setFreeOnly] = useState(false);

  function authFetch(url: string, opts: RequestInit = {}) {
    const headers: Record<string, string> = { ...(opts.headers as Record<string, string>) };
    let u = url;
    if (token) u += (u.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token);
    else if (session) headers["Authorization"] = `Bearer ${session.access_token}`;
    return fetch(u, { ...opts, headers, cache: "no-store" });
  }

  useEffect(() => {
    authFetch("/api/model-config")
      .then((r) => r.json())
      .then((d) => {
        setValue((d.overrides && d.overrides[bot]) || "");
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    fetch("/api/models", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setModels(Array.isArray(d.models) ? d.models : []))
      .catch(() => setModels([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot]);

  async function save(slug: string) {
    setStatus("Saving…");
    try {
      const r = await authFetch("/api/model-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bot, model: slug.trim() }),
      });
      if (!r.ok) throw new Error();
      setStatus("Saved ✓ — applies on the next query");
      setTimeout(() => setStatus(null), 3000);
    } catch {
      setStatus("Save failed");
    }
  }

  const FALLBACK: ModelOpt[] = [
    "anthropic/claude-sonnet-4-5",
    "anthropic/claude-haiku-4-5",
    "anthropic/claude-opus-4",
    "openai/gpt-4o",
    "openai/gpt-4o-mini",
    "google/gemini-2.5-pro",
  ].map((id) => ({ id, name: id, free: false, inPerM: 0, outPerM: 0 }));
  const all = models.length > 0 ? models : FALLBACK;

  const providers = ["all", ...Array.from(new Set(all.map((m) => m.id.split("/")[0]))).sort()];
  const q = query.trim().toLowerCase();
  const filtered = all.filter((m) => {
    if (provider !== "all" && m.id.split("/")[0] !== provider) return false;
    if (freeOnly && !m.free) return false;
    if (q && !m.id.toLowerCase().includes(q) && !m.name.toLowerCase().includes(q)) return false;
    return true;
  });

  const priceLabel = (m: ModelOpt) =>
    m.free ? "Free" : `$${m.inPerM.toFixed(2)} in / $${m.outPerM.toFixed(2)} out per 1M`;

  function choose(slug: string) {
    setValue(slug);
    setOpen(false);
    setQuery("");
    save(slug);
  }

  return (
    <div style={{ background: "#fff", border: `1px solid ${LINE}`, borderRadius: 12, padding: 18, marginBottom: 12, position: "relative" }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: INK, marginBottom: 4 }}>Model</div>
      <div style={{ fontSize: 12, color: MUTE, marginBottom: 10 }}>
        Override {bot}&rsquo;s model — search OpenRouter&rsquo;s full catalog, filter by provider, or show only free models. Currently in use: <code>{displayedModel}</code>
      </div>
      {!loaded ? (
        <div style={{ color: MUTE, fontSize: 13 }}>Loading…</div>
      ) : (
        <>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button
              onClick={() => setOpen((o) => !o)}
              style={{
                ...inpStyle, width: 360, marginTop: 0, textAlign: "left", cursor: "pointer",
                display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8,
                fontFamily: value ? "ui-monospace, Menlo, monospace" : undefined,
                color: value ? INK : MUTE,
              }}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {value || "Environment default"}
              </span>
              <span style={{ color: MUTE }}>▾</span>
            </button>
            {value && (
              <button
                onClick={() => { setValue(""); save(""); }}
                style={{ ...inpStyle, width: "auto", marginTop: 0, cursor: "pointer", color: MUTE }}
                title="Clear override — use the environment default"
              >
                Clear
              </button>
            )}
            {status && <span style={{ fontSize: 12.5, color: status.includes("fail") ? "#b42318" : MUTE }}>{status}</span>}
          </div>

          {open && (
            <>
              <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 20 }} />
              <div style={{
                position: "absolute", zIndex: 21, left: 18, right: 18, marginTop: 8,
                background: "#fff", border: `1px solid ${LINE}`, borderRadius: 12,
                boxShadow: "0 12px 32px rgba(15,18,34,0.16)", overflow: "hidden",
              }}>
                <div style={{ padding: 12, borderBottom: `1px solid ${LINE}`, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <input
                    autoFocus
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search models…"
                    style={{ ...inpStyle, marginTop: 0, flex: "1 1 200px" }}
                  />
                  <select value={provider} onChange={(e) => setProvider(e.target.value)} style={{ ...inpStyle, marginTop: 0, width: "auto", cursor: "pointer" }}>
                    {providers.map((p) => (
                      <option key={p} value={p}>{p === "all" ? "All providers" : p}</option>
                    ))}
                  </select>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: INK, cursor: "pointer", whiteSpace: "nowrap" }}>
                    <input type="checkbox" checked={freeOnly} onChange={(e) => setFreeOnly(e.target.checked)} />
                    Free only
                  </label>
                </div>
                <div style={{ maxHeight: 280, overflowY: "auto" }}>
                  {filtered.length === 0 ? (
                    <div style={{ padding: 16, color: MUTE, fontSize: 13 }}>No matching models.</div>
                  ) : (
                    filtered.slice(0, 200).map((m) => (
                      <div
                        key={m.id}
                        onClick={() => choose(m.id)}
                        style={{
                          padding: "9px 14px", cursor: "pointer", borderBottom: `1px solid #f0f1f4`,
                          background: m.id === value ? "#eef3ff" : "#fff",
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = "#f6f7f9")}
                        onMouseLeave={(e) => (e.currentTarget.style.background = m.id === value ? "#eef3ff" : "#fff")}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
                          <span style={{ fontSize: 13, color: INK, fontWeight: 500 }}>{m.name}</span>
                          {m.free && (
                            <span style={{ fontSize: 10.5, fontWeight: 700, color: "#067647", background: "#e7f6ec", borderRadius: 6, padding: "2px 7px", textTransform: "uppercase", letterSpacing: 0.4 }}>Free</span>
                          )}
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, marginTop: 2 }}>
                          <span style={{ fontSize: 11.5, color: MUTE, fontFamily: "ui-monospace, Menlo, monospace" }}>{m.id}</span>
                          {models.length > 0 && <span style={{ fontSize: 11, color: MUTE }}>{priceLabel(m)}</span>}
                        </div>
                      </div>
                    ))
                  )}
                </div>
                <div style={{ padding: "8px 14px", borderTop: `1px solid ${LINE}`, fontSize: 11.5, color: MUTE }}>
                  {filtered.length} model{filtered.length === 1 ? "" : "s"}{filtered.length > 200 ? " (showing first 200)" : ""}
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}


function ArcControls({ token, session }: { token: string; session: Session | null }) {
  const [mode, setMode] = useState("off");
  const [passphrase, setPassphrase] = useState("");
  const [allowlist, setAllowlist] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  function authFetch(url: string, opts: RequestInit = {}) {
    const headers: Record<string, string> = { ...(opts.headers as Record<string, string>) };
    let u = url;
    if (token) u += (u.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token);
    else if (session) headers["Authorization"] = `Bearer ${session.access_token}`;
    return fetch(u, { ...opts, headers, cache: "no-store" });
  }

  useEffect(() => {
    authFetch("/api/arc-config")
      .then((r) => r.json())
      .then((d) => {
        const c = d.config || {};
        setMode(c.mode || "off");
        setPassphrase(c.passphrase || "");
        setAllowlist((c.allowlist || []).join("\n"));
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save() {
    setStatus("Saving…");
    try {
      const r = await authFetch("/api/arc-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          passphrase,
          allowlist: allowlist.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
        }),
      });
      if (!r.ok) throw new Error();
      setStatus("Saved ✓");
      setTimeout(() => setStatus(null), 2500);
    } catch {
      setStatus("Save failed");
    }
  }

  const modes: { id: string; label: string; hint: string }[] = [
    { id: "off", label: "Off", hint: "ARC ignores all messages (kill switch)." },
    { id: "open", label: "Open", hint: "Anyone who messages ARC gets answers." },
    { id: "passphrase", label: "Passphrase", hint: "Users must send the access phrase once to unlock." },
    { id: "allowlist", label: "Allowlist", hint: "Only listed Slack ids / WhatsApp numbers are answered." },
  ];
  const current = modes.find((m) => m.id === mode);

  return (
    <div style={{ background: "#fff", border: `1px solid ${LINE}`, borderRadius: 12, padding: 18, marginBottom: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: INK, marginBottom: 12 }}>Access control</div>
      {!loaded ? (
        <div style={{ color: MUTE, fontSize: 13 }}>Loading…</div>
      ) : (
        <>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {modes.map((m) => {
              const on = m.id === mode;
              return (
                <button key={m.id} onClick={() => setMode(m.id)} style={{
                  padding: "7px 14px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer",
                  border: `1px solid ${on ? ACCENT : LINE}`, background: on ? ACCENT : "#fff", color: on ? "#fff" : INK,
                }}>{m.label}</button>
              );
            })}
          </div>
          <div style={{ color: MUTE, fontSize: 12.5, marginTop: 8 }}>{current?.hint}</div>

          {mode === "passphrase" && (
            <div style={{ marginTop: 12 }}>
              <label style={lblStyle}>Access phrase</label>
              <input style={inpStyle} value={passphrase} onChange={(e) => setPassphrase(e.target.value)} placeholder="e.g. ACTIVANT" />
            </div>
          )}
          {mode === "allowlist" && (
            <div style={{ marginTop: 12 }}>
              <label style={lblStyle}>Allowed Slack user ids / WhatsApp numbers (one per line)</label>
              <textarea
                style={{ ...inpStyle, height: 90, resize: "vertical", fontFamily: "ui-monospace, Menlo, monospace" }}
                value={allowlist}
                onChange={(e) => setAllowlist(e.target.value)}
                placeholder={"U012ABC...\n+14155550123"}
              />
            </div>
          )}

          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 14 }}>
            <button onClick={save} style={{ ...primaryBtn, width: "auto", marginTop: 0, padding: "9px 18px" }}>Save</button>
            {status && <span style={{ fontSize: 12.5, color: status.includes("fail") ? "#b42318" : MUTE }}>{status}</span>}
          </div>
        </>
      )}
    </div>
  );
}

const lblStyle: CSSProperties = { display: "block", fontSize: 12, color: MUTE, marginBottom: 6, marginTop: 12 };
const inpStyle: CSSProperties = { width: "100%", padding: "10px 12px", border: `1px solid ${LINE}`, borderRadius: 8, fontSize: 14, boxSizing: "border-box" };
const primaryBtn: CSSProperties = { width: "100%", marginTop: 18, padding: "11px 16px", background: ACCENT, color: "#fff", border: "none", borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: "pointer" };
const ghostBtn: CSSProperties = { padding: "8px 14px", background: "#fff", color: INK, border: `1px solid ${LINE}`, borderRadius: 8, fontSize: 13, cursor: "pointer" };
