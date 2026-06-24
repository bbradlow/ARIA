"use client";

import { useEffect, useMemo, useState } from "react";

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
type Metrics = {
  generatedAt: string;
  windowDays: number;
  bots: Record<string, BotData>;
};

const TABS = ["ARIA", "APRIL", "ARC"] as const;
const ACCENT = "#2f6feb";
const INK = "#0f1222";
const MUTE = "#6b7280";
const LINE = "#e6e8ee";
const BG = "#f6f7f9";

export default function Dashboard() {
  const [token, setToken] = useState("");
  const [tokenInput, setTokenInput] = useState("");
  const [data, setData] = useState<Metrics | null>(null);
  const [active, setActive] = useState<(typeof TABS)[number]>("ARIA");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("token") ?? "";
    if (t) setToken(t);
  }, []);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/metrics?token=${encodeURIComponent(token)}`, { cache: "no-store" });
        if (!res.ok) throw new Error(res.status === 401 ? "Invalid token." : `Request failed (${res.status}).`);
        const json = (await res.json()) as Metrics;
        if (!cancelled) setData(json);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const bot = data?.bots?.[active];

  if (!token) {
    return (
      <Shell>
        <div style={{ maxWidth: 420, margin: "80px auto", textAlign: "center" }}>
          <h1 style={{ fontSize: 22, color: INK, marginBottom: 8 }}>Bot Metrics</h1>
          <p style={{ color: MUTE, marginBottom: 20 }}>Enter the dashboard token to continue.</p>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="password"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder="Token"
              style={{ flex: 1, padding: "10px 12px", border: `1px solid ${LINE}`, borderRadius: 8, fontSize: 14 }}
            />
            <button
              onClick={() => setToken(tokenInput.trim())}
              style={{ padding: "10px 16px", background: ACCENT, color: "#fff", border: "none", borderRadius: 8, fontSize: 14, cursor: "pointer" }}
            >
              View
            </button>
          </div>
          <p style={{ color: MUTE, fontSize: 12, marginTop: 14 }}>
            Tip: open <code>/dashboard?token=YOUR_TOKEN</code> to skip this.
          </p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 22, color: INK, margin: 0 }}>Bot Metrics</h1>
          <p style={{ color: MUTE, margin: "4px 0 0", fontSize: 13 }}>
            {data ? `Last ${data.windowDays} days · updated ${new Date(data.generatedAt).toLocaleString()}` : "Loading…"}
          </p>
        </div>
        <button
          onClick={() => setToken((t) => t)}
          disabled={loading}
          style={{ padding: "8px 14px", background: "#fff", color: INK, border: `1px solid ${LINE}`, borderRadius: 8, fontSize: 13, cursor: "pointer" }}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      <div style={{ display: "flex", gap: 4, background: "#eef0f4", padding: 4, borderRadius: 10, width: "fit-content", marginTop: 18 }}>
        {TABS.map((t) => {
          const on = t === active;
          const dep = data?.bots?.[t]?.deployed;
          return (
            <button
              key={t}
              onClick={() => setActive(t)}
              style={{
                padding: "8px 18px",
                border: "none",
                borderRadius: 7,
                fontSize: 14,
                fontWeight: 600,
                cursor: "pointer",
                background: on ? "#fff" : "transparent",
                color: on ? INK : MUTE,
                boxShadow: on ? "0 1px 2px rgba(0,0,0,0.08)" : "none",
                display: "flex",
                alignItems: "center",
                gap: 7,
              }}
            >
              {t}
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: dep ? "#22c55e" : "#cbd2dd" }} />
            </button>
          );
        })}
      </div>

      {error && (
        <div style={{ marginTop: 20, padding: 14, background: "#fff4f4", border: "1px solid #ffd5d5", borderRadius: 8, color: "#b42318", fontSize: 14 }}>
          {error}
        </div>
      )}

      {bot && (
        <div style={{ marginTop: 22 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
            <h2 style={{ fontSize: 17, color: INK, margin: 0 }}>{bot.name}</h2>
            <span style={{ fontSize: 13, color: MUTE }}>{bot.label}</span>
            {!bot.deployed && (
              <span style={{ fontSize: 12, color: "#92690b", background: "#fff7e6", border: "1px solid #ffe3a3", padding: "2px 8px", borderRadius: 999 }}>
                no data yet
              </span>
            )}
          </div>

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

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: "100vh", background: BG, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif" }}>
      <div style={{ maxWidth: 1040, margin: "0 auto", padding: "32px 24px 64px" }}>{children}</div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
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
  if (total === 0) {
    return <div style={{ color: MUTE, fontSize: 13, padding: "30px 0", textAlign: "center" }}>No activity in this window yet.</div>;
  }
  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 160 }}>
        {points.map((p) => (
          <div key={p.date} title={`${p.date}: ${p.count}`} style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "flex-end", height: "100%" }}>
            <div
              style={{
                height: `${(p.count / max) * 100}%`,
                minHeight: p.count > 0 ? 3 : 0,
                background: ACCENT,
                borderRadius: "3px 3px 0 0",
                opacity: p.count > 0 ? 1 : 0,
              }}
            />
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
  if (!rows.length) {
    return <div style={{ color: MUTE, fontSize: 13, padding: "30px 0", textAlign: "center" }}>No events yet.</div>;
  }
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
