import { ThreadMessage } from "@/lib/slack";

// Direct Affinity REST integration (replaces the MCP connector, which was too
// slow for writes). Flow: ONE planner LLM call turns the request into a
// structured action, we execute it with direct Affinity API calls, then ONE
// responder LLM call phrases the result for Slack. No multi-step agentic loop.

const AFFINITY_BASE = "https://api.affinity.co";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// AFFINITY_MODEL is now an OpenRouter slug (we no longer call Anthropic directly).
const MODEL = process.env.AFFINITY_MODEL?.trim() || "anthropic/claude-sonnet-4-5";
// Master pipeline list ID (override per instance). Defaults to Activant's.
const PIPELINE_LIST_ID = process.env.AFFINITY_PIPELINE_LIST_ID?.trim() || "93884";
const READ_ONLY = process.env.AFFINITY_READ_ONLY === "true";

function affinityKey(): string {
  const k = process.env.AFFINITY_API_KEY;
  if (!k) throw new Error("Missing AFFINITY_API_KEY environment variable");
  return k;
}

// v1 = HTTP Basic with the API key as the password (empty username).
function v1AuthHeader(): string {
  return "Basic " + Buffer.from(":" + affinityKey()).toString("base64");
}
// v2 = Bearer with the API key as the token.
function v2AuthHeader(): string {
  return "Bearer " + affinityKey();
}

async function fetchJson(url: string, init: RequestInit, label: string): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const body = await res.text();
    if (!res.ok) {
      throw new Error(`${label} failed (${res.status}): ${body.slice(0, 200)}`);
    }
    return body ? JSON.parse(body) : {};
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`${label} timed out`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function v1Get(path: string): Promise<any> {
  return fetchJson(`${AFFINITY_BASE}${path}`, { headers: { Authorization: v1AuthHeader() } }, `Affinity v1 ${path}`);
}
function v2Request(path: string, init: RequestInit = {}): Promise<any> {
  return fetchJson(
    `${AFFINITY_BASE}${path}`,
    {
      ...init,
      headers: {
        Authorization: v2AuthHeader(),
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
    },
    `Affinity v2 ${path}`
  );
}

// ---------------------------------------------------------------------------
// Executors — each does a small, fixed number of direct API calls.
// ---------------------------------------------------------------------------

async function searchCompanies(term: string): Promise<any[]> {
  const data = await v1Get(`/organizations?term=${encodeURIComponent(term)}`);
  return (data.organizations ?? []).slice(0, 5).map((o: any) => ({
    id: o.id,
    name: o.name,
    domain: o.domain ?? o.domains?.[0] ?? null,
  }));
}

// Enriched company profile: industry, description, and other non-list-specific
// fields. These only come back when fieldTypes is specified.
async function getCompanyDetails(id: number | string): Promise<any> {
  const params =
    "fieldTypes=enriched&fieldTypes=global&fieldTypes=relationship-intelligence";
  const data = await v2Request(`/v2/companies/${id}?${params}`);
  const fields = (data.fields ?? [])
    .map((f: any) => ({ name: f.name, value: f.value?.data ?? f.value ?? null }))
    .filter((f: any) => f.value !== null && f.value !== undefined && f.value !== "");
  return {
    id: data.id ?? id,
    name: data.name ?? null,
    domain: data.domain ?? data.domains?.[0] ?? null,
    fields,
  };
}

async function listPipeline(limit: number): Promise<any[]> {
  const n = Math.min(Math.max(limit || 25, 1), 100);
  const data = await v2Request(`/v2/lists/${PIPELINE_LIST_ID}/list-entries?limit=${n}`);
  const rows = data.data ?? data ?? [];
  return rows.map((e: any) => ({
    listEntryId: e.id,
    name: e.entity?.name ?? e.entity?.fullName ?? "(unknown)",
    type: e.entity?.type ?? null,
  }));
}

async function getListFields(): Promise<any[]> {
  const data = await v2Request(`/v2/lists/${PIPELINE_LIST_ID}/fields`);
  return data.data ?? data ?? [];
}

async function findPipelineEntryByName(name: string): Promise<any | null> {
  const target = name.trim().toLowerCase();
  // Scan up to ~300 entries across a few pages, matching by entity name.
  let url: string | null = `/v2/lists/${PIPELINE_LIST_ID}/list-entries?limit=100`;
  for (let page = 0; page < 3 && url; page++) {
    const data: any = await v2Request(url);
    const rows = data.data ?? data ?? [];
    for (const e of rows) {
      const nm = (e.entity?.name ?? e.entity?.fullName ?? "").toLowerCase();
      if (nm === target || nm.includes(target)) return e;
    }
    const next = data.pagination?.nextUrl ?? null;
    url = next ? next.replace(AFFINITY_BASE, "") : null;
  }
  return null;
}

async function updateField(term: string, fieldName: string, value: string): Promise<any> {
  if (READ_ONLY) {
    throw new Error("ARIA is in read-only mode (AFFINITY_READ_ONLY=true); field updates are disabled.");
  }
  const fields = await getListFields();
  const fn = fieldName.trim().toLowerCase();
  const field =
    fields.find((f: any) => (f.name ?? "").toLowerCase() === fn) ||
    fields.find((f: any) => (f.name ?? "").toLowerCase().includes(fn));
  if (!field) {
    throw new Error(`Field "${fieldName}" not found on the pipeline list.`);
  }

  const ro = readOnlyReason(field);
  if (ro) {
    throw new Error(
      `"${field.name}" is ${ro} and is read-only via the Affinity API — it can't be set programmatically (even when blank). Use a custom field your team created, or edit it in the Affinity UI.`
    );
  }

  const entry = await findPipelineEntryByName(term);
  if (!entry) {
    throw new Error(`"${term}" not found in the pipeline list.`);
  }

  const type = field.type ?? field.valueType ?? "text";
  await v2Request(`/v2/lists/${PIPELINE_LIST_ID}/list-entries/${entry.id}/fields`, {
    method: "PATCH",
    body: JSON.stringify({
      operation: "update-fields",
      updates: [{ fieldId: field.id, value: { type, data: buildFieldData(type, value) } }],
    }),
  });

  return {
    updated: true,
    scope: "pipeline list field",
    entity: entry.entity?.name ?? entry.entity?.fullName ?? term,
    field: field.name,
    value,
  };
}

// Update a GLOBAL field on a company's profile directly (any company, not tied
// to a list). Uses the company endpoint with a typed value object.
async function getCompanyFields(): Promise<any[]> {
  const data = await v2Request(`/v2/companies/fields`);
  return data.data ?? data ?? [];
}

function buildFieldData(type: string, value: string): any {
  const t = String(type).toLowerCase();
  const scalar = t.startsWith("number") ? Number(value) : value;
  return t.endsWith("-multi") ? [scalar] : scalar;
}

// Returns a reason if a field is read-only via the API (Affinity-enriched /
// data-partner fields), else null. These can't be written even when blank.
function readOnlyReason(field: any): string | null {
  const id = String(field.id ?? "").toLowerCase();
  const type = String(field.type ?? field.valueType ?? "").toLowerCase();
  if (id.startsWith("affinity-data-") || id.startsWith("dealroom-")) {
    return "an Affinity-enriched field (populated by a data partner)";
  }
  if (type.startsWith("filterable-text")) {
    return `type "${type}", which is Affinity-populated`;
  }
  const e = field.enrichmentSource ?? field.enrichment_source ?? field.source ?? null;
  if (e && String(e).toLowerCase() !== "none") return `enriched (source: ${e})`;
  return null;
}

async function updateCompanyField(term: string, fieldName: string, value: string): Promise<any> {
  if (READ_ONLY) {
    throw new Error("ARIA is in read-only mode (AFFINITY_READ_ONLY=true); field updates are disabled.");
  }
  const matches = await searchCompanies(term);
  const company = matches[0];
  if (!company) throw new Error(`Company "${term}" not found.`);

  const fields = await getCompanyFields();
  const fn = fieldName.trim().toLowerCase();
  const field =
    fields.find((f: any) => (f.name ?? "").toLowerCase() === fn) ||
    fields.find((f: any) => (f.name ?? "").toLowerCase().includes(fn));
  if (!field) throw new Error(`Field "${fieldName}" not found on company profiles.`);

  const ro = readOnlyReason(field);
  if (ro) {
    throw new Error(
      `"${field.name}" is ${ro} and is read-only via the Affinity API — it can't be set programmatically (even when blank). Use a custom field your team created, or edit it in the Affinity UI.`
    );
  }

  const type = field.type ?? field.valueType ?? "text";
  // Complex types need structured values we can't infer from plain text.
  if (/^(location|person|company|interaction|filterable)/i.test(String(type)) && !/-multi$/i.test(String(type))) {
    throw new Error(`Field "${field.name}" is of type "${type}", which needs a structured value I can't set from plain text yet.`);
  }

  await v2Request(`/v2/companies/${company.id}/fields/${field.id}`, {
    method: "POST",
    body: JSON.stringify({ value: { type, data: buildFieldData(type, value) } }),
  });

  return {
    updated: true,
    scope: "company profile (global field)",
    entity: company.name,
    field: field.name,
    value,
  };
}

// ---------------------------------------------------------------------------
// LLM helpers (OpenRouter) — one to plan, one to phrase the result.
// ---------------------------------------------------------------------------

async function openRouterChat(messages: { role: string; content: string }[]): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY environment variable");

  const data = await fetchJson(
    OPENROUTER_URL,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://activantcapital.com",
        "X-Title": "Activant Research Bot",
      },
      body: JSON.stringify({ model: MODEL, messages }),
    },
    "OpenRouter"
  );
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}

const PLANNER_PROMPT =
  "You convert a request about Activant's Affinity CRM into a SINGLE JSON action. " +
  "Output ONLY raw JSON, no prose, no code fences. Schema: " +
  '{"action": "search"|"get_company"|"list_pipeline"|"list_fields"|"update_field"|"update_company_field"|"answer", ' +
  '"term"?: string, "field"?: string, "value"?: string, "limit"?: number, "reply"?: string}. ' +
  "Guidance: 'search' to find companies by name/keyword (set term). " +
  "'get_company' for details on one company (set term to its name). " +
  "'list_pipeline' to list entries in the master pipeline (optional limit). " +
  "'list_fields' to list the master pipeline's fields and which ones are editable (use for 'what fields can I edit' or to find a writable field). " +
  "'update_field' is the DEFAULT for changing a field on a company — the editable pipeline fields (e.g. Status, Outreach Status, Sector, Thesis Category, Close Date, Pass Rationale, Excitement Level, Owners) live on the master pipeline list. Set term=company name, field, value. Use this for any 'update/set <company>'s <field>' request unless the user explicitly says the field is a global or company-profile field. " +
  "'update_company_field' ONLY when the user explicitly asks to change a global / company-profile field rather than a pipeline field (set term=company name, field, value). " +
  "'answer' when no CRM lookup is needed (set reply to the text). " +
  "Use the conversation context to resolve references like 'it' or 'that company'." +
  (READ_ONLY
    ? " READ-ONLY MODE: never use update_field or update_company_field; if asked to change data, use action 'answer' explaining you are read-only."
    : "");

function latestUserText(history: ThreadMessage[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "user") return history[i].content;
  }
  return history[history.length - 1]?.content ?? "";
}

function parseAction(raw: string): any {
  const cleaned = raw.replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {}
    }
    return { action: "answer", reply: "Sorry — I couldn't interpret that request." };
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function askAffinity(history: ThreadMessage[]): Promise<string> {
  if (!history || history.length === 0) {
    return "Ask me about the pipeline — e.g. `$aff what stage is OpenMind in?`";
  }

  const conversation = history
    .slice(-8)
    .map((m) => `${m.role === "assistant" ? "ARIA" : "User"}: ${m.content}`)
    .join("\n");
  const request = latestUserText(history);

  // 1) Plan.
  const planRaw = await openRouterChat([
    { role: "system", content: PLANNER_PROMPT },
    { role: "user", content: `Conversation so far:\n${conversation}\n\nLatest request: ${request}\n\nReturn the JSON action.` },
  ]);
  const action = parseAction(planRaw);

  if (action.action === "answer") {
    return action.reply || "Done.";
  }

  // 2) Execute against Affinity.
  let result: any;
  try {
    switch (action.action) {
      case "search":
        result = { matches: await searchCompanies(action.term ?? request) };
        break;
      case "get_company": {
        const matches = await searchCompanies(action.term ?? request);
        const top = matches[0] ?? null;
        let company: any = top;
        if (top) {
          try {
            company = await getCompanyDetails(top.id);
          } catch (e) {
            console.error("Company enrichment failed, using basic record:", e);
          }
        }
        result = { company, otherMatches: matches.slice(1) };
        break;
      }
      case "list_pipeline":
        result = { pipeline: await listPipeline(action.limit ?? 25) };
        break;
      case "list_fields": {
        const lf = await getListFields();
        result = {
          fields: lf.map((f: any) => ({
            name: f.name,
            type: f.type ?? f.valueType ?? null,
            editable: !readOnlyReason(f),
          })),
        };
        break;
      }
      case "update_field":
        result = await updateField(action.term ?? "", action.field ?? "", String(action.value ?? ""));
        break;
      case "update_company_field":
        result = await updateCompanyField(action.term ?? "", action.field ?? "", String(action.value ?? ""));
        break;
      default:
        return "I wasn't sure what to do with that — try rephrasing.";
    }
  } catch (err) {
    // Surface the real reason (the events handler wraps this in a Slack message).
    throw err instanceof Error ? err : new Error(String(err));
  }

  // 3) Phrase the result for Slack.
  const RESPONDER_PROMPT =
    "You are ARIA, a CRM assistant for Activant Capital. Given a user request and the raw JSON result from Affinity, write a concise Slack answer. " +
    "Use Slack formatting: single asterisks for *bold*, '•' for bullets, no markdown headers. " +
    "State facts from the data only; if the result is empty, say nothing matched. When a company has enriched fields (industry, description, location, headcount, etc.), surface the most useful ones. For an update, confirm exactly what changed.";

  return await openRouterChat([
    { role: "system", content: RESPONDER_PROMPT },
    {
      role: "user",
      content: `Request: ${request}\n\nAffinity result (JSON):\n${JSON.stringify(result).slice(0, 6000)}\n\nWrite the Slack answer.`,
    },
  ]);
}
