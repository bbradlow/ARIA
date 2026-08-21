# ARIA — Activant Research Slack Bot

ARIA (Activant Research Intelligence Assistant) is a Slack bot for Activant
Capital. It is a Next.js (App Router) application deployed on Vercel, backed
by Supabase (Postgres + pgvector). It has three jobs:

1. **Summarize new research.** A newsletter email forwarded to a Postmark
   inbound address triggers a webhook that dedupes, summarizes the article
   with an LLM (via OpenRouter), and fans the summary out as Slack DMs and
   channel posts. There is no scraping, polling, or cron job — the inbound
   email is the trigger.
2. **Answer questions from the research library.** DMs and @mentions are
   treated as questions; ARIA embeds the query (Voyage `voyage-finance-2`),
   retrieves the closest chunks from `research_chunks` via pgvector cosine
   similarity, and answers grounded only in that retrieved text, with source
   links.
3. **Query Activant's CRM (`$aff` mode).** `@ARIA $aff <query>` switches to
   CRM mode, where Claude (Anthropic Messages API) answers using Affinity's
   pipeline/contacts/orgs/deals data through an Affinity MCP connector, using
   recent conversation history for follow-up questions.

```
Newsletter email
      │  (forwarded to a Postmark inbound address)
      ▼
Postmark Inbound Stream ──POST──▶ /api/email/inbound
                                      │ dedupe (Supabase)
                                      │ summarize (OpenRouter → Claude)
                                      │ fan out DMs (Slack chat.postMessage)
                                      ▼
                                  Subscribers / channels / group DMs

Slack DM/@mention ──▶ /api/slack/events ──▶ subscribe/unsubscribe,
                                             research Q&A, or $aff CRM mode
```

A companion doc, `ARIA-User-Guide.md`, describes the bot from an end user's
point of view (how to subscribe, ask questions, use `$aff`, etc.) rather than
the implementation.

## Project structure

```
app/
  layout.tsx                     Root layout / page metadata
  page.tsx                       Client-side dashboard (Supabase-auth gated):
                                  queries-per-day chart, events-by-type chart,
                                  model/prompt overrides for ARIA/APRIL/ARC
  api/
    email/inbound/route.ts       Postmark webhook: dedupe → summarize → fan out
    slack/events/route.ts        Slack events webhook: subscribe/unsubscribe,
                                  channel/group-DM registration, Q&A routing,
                                  $aff CRM mode, custom commands
    ingest/route.ts               Admin: crawl & embed the research back catalog
    backfill-dates/route.ts       Admin: backfill published_at on existing rows
    metrics/route.ts              Dashboard data API (reads bot_events)
    model-config/route.ts         Dashboard: per-bot model overrides (bot_config)
    prompt-config/route.ts        Dashboard: per-bot system-prompt overrides
    models/route.ts               Proxies/caches the OpenRouter model catalog
    arc-config/route.ts           Config endpoint for the ARC bot's dashboard tab

lib/
  supabase.ts                    Lazily-instantiated service-role Supabase client
  slack.ts                       sendSlackDM/postSlackMessage + HMAC signature
                                  verification for Slack requests
  ingest.ts                      Crawls activantcapital.com/research, fetches
                                  articles, chunks + embeds + stores them
  chunk.ts                       Splits article text into overlapping chunks
                                  on paragraph boundaries (~600-750 tokens each)
  embeddings.ts                  Voyage AI embeddings client (voyage-finance-2,
                                  1024-dim vectors)
  retrieval.ts                   pgvector similarity search over research_chunks
  qa.ts                          Research Q&A: retrieval + LLM answer generation,
                                  system prompt, article-index/date handling
  commands.ts                    User-definable custom Slack commands (define/
                                  list/delete), backed by Supabase
  metrics.ts                     Event logging into the shared bot_events table
                                  (ARIA/APRIL/ARC all write here; never throws)
  model-config.ts                Reads dashboard-set model/prompt overrides from
                                  bot_config, with a short in-memory TTL cache

ARIA-User-Guide.md               End-user usage guide (not implementation docs)
vercel.json                      Function config (60s maxDuration for the
                                  inbound-email route; no cron)
next.config.mjs / tsconfig.json  Next.js + TypeScript config (@/ → project root)
.env.example                     Template for required/optional environment vars
```

## Data model (Supabase / Postgres)

- `processed_emails` — claims each inbound `MessageID` so retries can't
  double-send.
- `subscribers` — Slack user IDs subscribed to DM summaries.
- `channels` — channels/group DMs the bot posts to, with an `active` flag
  used to pause/resume without losing registration.
- `research_chunks` (+ `pgvector` `hnsw` index and a `match_research_chunks`
  SQL function) — one row per chunk of an ingested article, with its
  embedding, used for both Q&A retrieval and the article date index.
- `bot_events` — shared event log written by ARIA, APRIL, and ARC; read by
  the dashboard's metrics charts.
- `bot_config` — per-bot model/system-prompt overrides set from the
  dashboard, read (with caching) by `lib/model-config.ts`.

## Environment variables

See `.env.example` for the full list with comments. Required: `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `OPENROUTER_API_KEY`, `SLACK_BOT_TOKEN`,
`SLACK_SIGNING_SECRET`, `POSTMARK_WEBHOOK_TOKEN`, `VOYAGE_API_KEY`,
`INGEST_TOKEN`. Needed for `$aff` CRM mode: `ANTHROPIC_API_KEY`,
`AFFINITY_MCP_TOKEN`. Optional overrides: `SUMMARY_SYSTEM_PROMPT`,
`SUMMARY_MODEL`, `QA_MODEL`, `METRICS_TOKEN`.

`POSTMARK_WEBHOOK_TOKEN` must match the `?token=` query param on the Postmark
inbound webhook URL. `INGEST_TOKEN` (and `METRICS_TOKEN` if set) guard the
admin endpoints the same way.

## Running / deploying

```bash
npm install     # install dependencies
npm run dev     # local dev server (next dev)
npm run build   # production build
npm run start   # run a production build
vercel --prod   # deploy
```

To (re)populate the research library from the existing article back catalog,
hit `/api/ingest?token=<INGEST_TOKEN>` on the deployed app — it works in
batches (skipping already-stored articles) and can be re-visited until its
`remaining` count reaches 0. New newsletters are ingested automatically going
forward via `/api/email/inbound`, so this is only needed once (or after a
schema change requiring a re-ingest).

## Design notes

- **No double-sends.** The inbound route claims each `MessageID` in
  `processed_emails` before doing any work; the unique constraint makes a
  Postmark retry a no-op. If summarization or fan-out fails, the claim is
  released so the retry can re-run the full job.
- **Body extraction.** The summarizer prefers `TextBody`; if missing or very
  short, it falls back to stripping `HtmlBody` with cheerio.
- **Resilient fan-out.** A failure delivering one subscriber's DM is logged
  and skipped — it never aborts the rest.
- **Security.** Postmark requests are checked against a shared `?token=`
  secret with constant-time comparison. Slack requests are verified with
  HMAC-SHA256 over the raw body plus a 5-minute timestamp window.
- **`$aff` command prefix.** CRM mode uses a `$` prefix (not `/`) so Slack
  doesn't intercept it as a slash command.
