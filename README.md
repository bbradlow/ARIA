# Activant Research Slack Bot

A Slack bot that DMs a summary to every opted-in subscriber whenever a new
research newsletter email arrives. The newsletter email itself is the trigger —
there is **no scraping, polling, or cron job**.

```
Newsletter email
      │  (forwarded to your Postmark inbound address)
      ▼
Postmark Inbound Stream ──POST──▶ /api/email/inbound
                                      │ dedupe (Supabase)
                                      │ summarize (OpenRouter → Claude Sonnet 4.5)
                                      │ fan out DMs (Slack chat.postMessage)
                                      ▼
                                  Subscribers

Slack DM "subscribe" ──▶ /api/slack/events ──▶ insert/delete in Supabase
```

## Heads-up on Postmark cost

Postmark's free Developer plan (100 emails/month) does **not** include inbound
email processing — that feature is on the Pro plan ($16.50/mo) and Platform
plan ($18/mo). Since this bot depends on receiving inbound mail, plan on Pro.
Confirm current pricing at https://postmarkapp.com/pricing when you sign up.

## Project structure

```
app/api/email/inbound/route.ts   Inbound email handler (dedupe, summarize, DM)
app/api/slack/events/route.ts    Slack DM handler (subscribe/unsubscribe)
app/layout.tsx, app/page.tsx     Next.js boilerplate (no real UI)
lib/supabase.ts                  Supabase service-role client singleton
lib/slack.ts                     sendSlackDM + verifySlackSignature helpers
vercel.json                      Minimal config (function timeout, no cron)
package.json / tsconfig.json     Project + TypeScript config (@/ → project root)
```

---

## 1. Supabase

Create a project at https://supabase.com, then run this in the SQL editor
(choose **Run and enable RLS** if prompted — the server uses the secret /
service-role key, which bypasses RLS):

```sql
-- Tracks processed emails to prevent duplicate sends
create table processed_emails (
  id uuid primary key default gen_random_uuid(),
  message_id text unique not null,
  subject text,
  processed_at timestamptz default now()
);

-- Tracks subscribed Slack users (individual DMs)
create table subscribers (
  id uuid primary key default gen_random_uuid(),
  slack_user_id text unique not null,
  subscribed_at timestamptz default now()
);

-- Tracks channels and group DMs the bot posts to.
-- active = false means it's been paused (via an @mention "stop" in a group).
create table channels (
  id uuid primary key default gen_random_uuid(),
  slack_channel_id text unique not null,
  active boolean not null default true,
  added_at timestamptz default now()
);
```

If you already created the `channels` table from the previous version, just add
the new column instead:

```sql
alter table channels add column active boolean not null default true;
```

If you haven't created any of these yet, run the whole block above.

For the research Q&A feature, also enable `pgvector` and add a chunk table plus
a similarity-search function:

```sql
create extension if not exists vector;

-- One row per chunk of an article (article text is split before embedding).
create table research_chunks (
  id uuid primary key default gen_random_uuid(),
  article_title text,
  article_url text,
  published_at date,
  content text not null,
  embedding vector(1024),        -- matches Voyage voyage-finance-2
  created_at timestamptz default now()
);

create index on research_chunks using hnsw (embedding vector_cosine_ops);

-- Top-k nearest chunks by cosine similarity.
create or replace function match_research_chunks(
  query_embedding vector(1024),
  match_count int default 6
)
returns table (
  content text,
  article_title text,
  article_url text,
  similarity float
)
language sql stable
as $$
  select content, article_title, article_url,
         1 - (embedding <=> query_embedding) as similarity
  from research_chunks
  order by embedding <=> query_embedding
  limit match_count;
$$;
```

For `SUPABASE_URL`: Settings → Data API → Project URL (looks like
`https://<project-ref>.supabase.co`), or the green **Connect** button.
For `SUPABASE_SERVICE_ROLE_KEY`: Settings → API Keys → copy the **secret** key
(`sb_secret_…`). Make sure the Data API is enabled with the `public` schema
exposed (it is by default). Keep the secret key server-side only.

---

## 2. OpenRouter

At https://openrouter.ai create an API key (`OPENROUTER_API_KEY`) and add a
little credit so the summarization model can run.

---

## 3. Slack app

Create an app at https://api.slack.com/apps.

**Bot Token Scopes** (OAuth & Permissions): `chat:write`, `im:history`,
`im:write`, `users:read`, `channels:read`, `groups:read`, `mpim:history`,
`mpim:read`, `app_mentions:read`, `channels:history`, `groups:history`.
(`channels:read` / `groups:read` let the bot receive the "added to a channel"
events; `mpim:history` / `mpim:read` let it see group-DM messages;
`app_mentions:read` lets it receive @mentions in channels for Q&A;
`channels:history` / `groups:history` let it read thread history for the `$aff`
multi-turn CRM mode.)

Install the app to your workspace, then copy the **Bot User OAuth Token**
(`xoxb-…` → `SLACK_BOT_TOKEN`) and, from **Basic Information**, the **Signing
Secret** (`SLACK_SIGNING_SECRET`).

**App Home → Show Tabs**: enable the **Messages Tab** and check "Allow users to
send Slash commands and messages from the messages tab" — otherwise users can't
DM the bot.

**Event Subscriptions** (set the Request URL after you have a Vercel domain):
- Request URL: `https://<your-vercel-domain>/api/slack/events`
- Subscribe to bot events: `message.im`, `message.mpim`, `app_mention`,
  `member_joined_channel`, `member_left_channel`

After adding scopes or events you must **reinstall the app** for them to take
effect.

---

## 4. Postmark Inbound

Postmark receives the newsletter and POSTs it to the webhook. It does **not**
sign inbound requests, so the endpoint is secured with a secret you invent and
put in the URL.

1. Sign up at https://postmarkapp.com (inbound needs the Pro plan — see above)
   and create a new **Inbound Stream** (not a sending stream).
2. Copy the inbound email address it gives you (e.g.
   `abc123@inbound.postmarkapp.com`).
3. Pick a secret string for `POSTMARK_WEBHOOK_TOKEN` (any long random value).
4. In the Inbound Stream settings, set the **Webhook URL** to:
   `https://<your-vercel-domain>/api/email/inbound?token=<POSTMARK_WEBHOOK_TOKEN>`
5. **Forward the newsletter** to the Postmark inbound address — set a forwarding
   rule in Gmail/Outlook, or subscribe that address to the newsletter directly.

Unlike SendGrid, Postmark gives you a ready-made inbound address, so there's no
domain or MX-record setup required.

---

## 5. Environment variables

Set these in Vercel (**Project → Settings → Environment Variables**) and, for
local dev, in a `.env.local` file (see `.env.example`):

```
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
OPENROUTER_API_KEY=
SLACK_BOT_TOKEN=
SLACK_SIGNING_SECRET=
POSTMARK_WEBHOOK_TOKEN=
VOYAGE_API_KEY=          # embeddings for research Q&A (Voyage finance-2)
INGEST_TOKEN=            # guards the /api/ingest admin endpoint
ANTHROPIC_API_KEY=       # $aff CRM mode (Anthropic Messages API + MCP connector)
AFFINITY_MCP_TOKEN=      # OAuth bearer token for the Affinity MCP server
```

`POSTMARK_WEBHOOK_TOKEN` must be the exact same string you appended as `?token=`
on the Postmark webhook URL. `INGEST_TOKEN` is a long random string you invent;
you'll pass it as `?token=` when loading the back catalog (below).

---

## 6. Install & deploy

This is a Next.js App Router project; the `@/` import alias maps to the project
root via `tsconfig.json`.

```bash
npm install @supabase/supabase-js @vercel/functions cheerio
npm install          # install everything from package.json
vercel --prod        # deploy
```

After the first deploy, plug your real Vercel domain into the Postmark webhook
URL and the Slack Request URL.

### Load the research back catalog

Once deployed, populate the library by visiting the ingest endpoint in your
browser:

```
https://<your-vercel-domain>/api/ingest?token=<INGEST_TOKEN>
```

It crawls `activantcapital.com/research`, fetches each article, chunks, embeds,
and stores them. It works in batches to stay within the function time limit and
skips articles already stored — so if the JSON response shows `"remaining"` above
0, just refresh the URL until it reaches 0. New newsletters auto-ingest going
forward, so this is only needed once for the existing articles.

Note: Voyage's free trial caps embeddings at 3 requests/minute, which will make
most articles fail with a rate-limit error (shown in the `failed[]` array). Add
a payment method on the Voyage dashboard to lift the cap — the free token
allowance still applies, so you won't be charged at this volume.

---

## Using the bot

- DM the bot **`subscribe`** → added to `subscribers`, gets a confirmation.
- DM **`unsubscribe`** → removed, gets a goodbye.
- Any other DM → ARIA treats it as a question and searches the research library
  (type `help` to see the command list instead).
- **@mention the bot in a channel** with a question → it answers from the
  research library, in a thread, with source links. (Anything that isn't a
  start/stop command is treated as a question.)
- **`@ARIA $aff <query>`** → CRM mode: instead of the research library, ARIA
  queries Activant's Affinity pipeline/contacts/orgs/deals (via the Affinity MCP
  server) and replies in-thread. Follow-ups in the same thread keep context, so
  you can ask "and which of those closed?" without repeating yourself. In a
  direct message you can drop the mention and just send `$aff <query>` — the `$`
  prefix is used (not `/`) so Slack doesn't intercept it as a slash command.
- **Add the bot to a channel** (e.g. `/invite @ARIA`) → it registers that
  channel and posts every future summary there too. Remove it from the channel
  to stop. Private channels work if you invite the bot directly.
- **Add the bot to a group DM** → once someone sends any message in the group,
  the bot registers it and starts posting summaries there. To pause it,
  **@mention the bot with "stop"** (e.g. `@ARIA stop`); mention it with "start"
  to resume. Pausing is durable — a paused group stays off until someone
  explicitly starts it, and casual use of the word "stop" in conversation does
  nothing (the command must @mention the bot).

When a newsletter arrives, every subscriber, channel, and group DM receives:

```
📄 *<Subject line>*

<3–5 sentence executive summary>
<https://activantcapital.com/…|Read the full piece →>
```

The link line is appended in code (not by the model) whenever a full-article
URL can be found in the email, so it stays correct regardless of which prompt
you use.

---

## Design notes

- **No double-sends.** The inbound route *claims* each `MessageID` in
  `processed_emails` before doing any work; the unique constraint makes a
  Postmark retry a no-op. If summarization or fan-out then fails, the claim is
  released so the retry can re-run the full job.
- **Body extraction.** The summarizer prefers `TextBody`; if it's missing or
  very short, it falls back to stripping `HtmlBody` with cheerio.
- **Resilient fan-out.** A failure delivering one subscriber's DM is logged and
  skipped — it never aborts the rest.
- **Security.** Postmark requests are checked against a shared `?token=` secret
  with constant-time comparison. Slack requests are verified with HMAC-SHA256
  over the raw body plus a 5-minute timestamp window.
