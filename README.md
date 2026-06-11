# Activant Research Slack Bot

A Slack bot that DMs a summary to every opted-in subscriber whenever a new
research newsletter email arrives. The newsletter email itself is the trigger —
there is **no scraping, polling, or cron job**.

```
Newsletter email
      │  (forwarded)
      ▼
Postmark inbound stream ──POST──▶ /api/email/inbound
                                      │ dedupe (Supabase)
                                      │ summarize (OpenRouter → Claude Sonnet 4.5)
                                      │ fan out DMs (Slack chat.postMessage)
                                      ▼
                                  Subscribers

Slack DM "subscribe" ──▶ /api/slack/events ──▶ insert/delete in Supabase
```

## Project structure

```
app/api/email/inbound/route.ts   Inbound email handler (dedupe, summarize, DM)
app/api/slack/events/route.ts    Slack DM handler (subscribe/unsubscribe)
lib/supabase.ts                  Supabase service-role client singleton
lib/slack.ts                     sendSlackDM + verifySlackSignature helpers
vercel.json                      Minimal config (function timeout, no cron)
package.json / tsconfig.json     Project + TypeScript config (@/ → project root)
```

---

## 1. Supabase

Create a project at https://supabase.com, then run this in the SQL editor:

```sql
-- Tracks processed emails to prevent duplicate sends
create table processed_emails (
  id uuid primary key default gen_random_uuid(),
  message_id text unique not null,
  subject text,
  processed_at timestamptz default now()
);

-- Tracks subscribed Slack users
create table subscribers (
  id uuid primary key default gen_random_uuid(),
  slack_user_id text unique not null,
  subscribed_at timestamptz default now()
);
```

From **Project Settings → API**, copy the **Project URL** and the
**`service_role`** key (server-side only — never expose it to the browser).

---

## 2. Postmark (inbound email)

1. Sign up at https://postmarkapp.com and create a new **Inbound Stream**
   (not a sending stream).
2. Copy the generated inbound address (e.g. `abc123@inbound.postmarkapp.com`).
3. Set the stream's **Webhook URL** to:

   ```
   https://<your-vercel-domain>/api/email/inbound?token=<POSTMARK_WEBHOOK_TOKEN>
   ```

   Postmark does **not** HMAC-sign inbound webhooks, so the endpoint is secured
   with a shared secret. Pick any long random string for
   `POSTMARK_WEBHOOK_TOKEN` and append it as the `?token=` query parameter on
   the webhook URL above. (Alternatively send it as an
   `X-Postmark-Webhook-Token` header.) Requests without the correct token get a
   `403`.
4. **Forward the newsletter to the Postmark address.** Either:
   - Add a forwarding rule in Gmail/Outlook that forwards each Activant research
     newsletter to the inbound address, **or**
   - Subscribe the inbound address to the newsletter directly.

The moment a newsletter lands, Postmark parses it and POSTs the JSON payload to
the webhook in real time.

---

## 3. Slack app

Create an app at https://api.slack.com/apps.

**Bot Token Scopes** (OAuth & Permissions):

| Scope | Why |
|---|---|
| `chat:write` | Send DMs |
| `im:history` | Read DMs sent to the bot |
| `im:write` | Open DM channels with users |
| `users:read` | Resolve user info if needed |

**Event Subscriptions:**
- Enable events and set the **Request URL** to
  `https://<your-vercel-domain>/api/slack/events`. Slack sends a one-time
  `url_verification` challenge — the route answers it automatically, so the URL
  verifies as soon as it's deployed.
- Under **Subscribe to bot events**, add `message.im`.

Install the app to your workspace, then from **Basic Information** /
**OAuth & Permissions** copy the **Bot User OAuth Token** (`xoxb-…`) and the
**Signing Secret**.

---

## 4. Environment variables

Set these in Vercel (**Project → Settings → Environment Variables**) and in a
local `.env.local` for development:

```
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
OPENROUTER_API_KEY=
SLACK_BOT_TOKEN=
SLACK_SIGNING_SECRET=
POSTMARK_WEBHOOK_TOKEN=
```

Get the OpenRouter key at https://openrouter.ai/keys.

---

## 5. Install & deploy

This project assumes a Next.js App Router project at the repo root (the `@/`
import alias maps to the project root via `tsconfig.json`). If you're starting
fresh, scaffold with `npx create-next-app@latest` and drop these files in.

```bash
npm install @supabase/supabase-js @vercel/functions cheerio
npm install            # install everything from package.json
vercel --prod          # deploy
```

> `@vercel/functions` provides `waitUntil`, which lets the Slack route
> acknowledge within Slack's 3-second window while finishing the
> Supabase/Slack work afterwards.

After the first deploy, plug your real Vercel domain into the Postmark webhook
URL and the Slack Request URL.

---

## Using the bot

- DM the bot **`subscribe`** → added to `subscribers`, gets a confirmation.
- DM **`unsubscribe`** → removed, gets a goodbye.
- Any other DM → a short help message.

When a newsletter arrives, every subscriber receives:

```
📄 *<Subject line>*

<3–5 sentence executive summary>
```

---

## Design notes

- **No double-sends.** The inbound route *claims* each `MessageID` by inserting
  it into `processed_emails` before doing any work; the unique constraint makes
  a Postmark retry a no-op. If summarization or fan-out then fails, the claim is
  released so the retry can re-run the full job.
- **Resilient fan-out.** A failure delivering one subscriber's DM is logged and
  skipped — it never aborts the rest.
- **Body extraction.** The summarizer prefers `TextBody`; if it's missing or
  very short, it falls back to stripping `HtmlBody` with cheerio.
- **Security.** Postmark requests are checked against a shared token; Slack
  requests are verified with HMAC-SHA256 over the raw body plus a 5-minute
  timestamp window. Both use constant-time comparison.
