# Activant Research Slack Bot

A Slack bot that DMs a summary to every opted-in subscriber whenever a new
research newsletter email arrives. The newsletter email itself is the trigger —
there is **no scraping, polling, or cron job**.

```
Newsletter email
      │  (forwarded to your SendGrid Inbound Parse address)
      ▼
SendGrid Inbound Parse ──POST──▶ /api/email/inbound
                                     │ dedupe (Supabase)
                                     │ summarize (OpenRouter → Claude Sonnet 4.5)
                                     │ fan out DMs (Slack chat.postMessage)
                                     ▼
                                 Subscribers

Slack DM "subscribe" ──▶ /api/slack/events ──▶ insert/delete in Supabase
```

## Before you start: requirements

- **A domain you control with DNS access.** SendGrid Inbound Parse receives
  mail on a subdomain of your own domain (e.g. `parse.yourdomain.com`) via an MX
  record — it does not give you a ready-made inbound address. If you can't edit
  DNS for a domain, this setup won't work; use Postmark Pro or Cloudflare Email
  Routing instead.
- Free accounts for Supabase, SendGrid, OpenRouter (small credit needed), and a
  Slack workspace where you can install an app.

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
(choose **Run and enable RLS** if prompted — the server uses the service-role
key, which bypasses RLS):

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

From **Project Settings → API**, copy the **Project URL** (`SUPABASE_URL`) and
the **`service_role`** secret key (`SUPABASE_SERVICE_ROLE_KEY` — server-side
only, never expose it to the browser).

---

## 2. OpenRouter

At https://openrouter.ai create an API key (`OPENROUTER_API_KEY`) and add a
little credit so the summarization model can run.

---

## 3. Slack app

Create an app at https://api.slack.com/apps.

**Bot Token Scopes** (OAuth & Permissions): `chat:write`, `im:history`,
`im:write`, `users:read`.

Install the app to your workspace, then copy the **Bot User OAuth Token**
(`xoxb-…` → `SLACK_BOT_TOKEN`) and, from **Basic Information**, the **Signing
Secret** (`SLACK_SIGNING_SECRET`).

**Event Subscriptions** (set the Request URL after you have a Vercel domain):
- Request URL: `https://<your-vercel-domain>/api/slack/events`
- Subscribe to bot event: `message.im`

---

## 4. SendGrid Inbound Parse

SendGrid receives the newsletter and POSTs it to the webhook. It does **not**
sign the request, so the endpoint is secured with a secret you invent and put in
the URL.

1. Sign up at https://sendgrid.com (free tier includes Inbound Parse).
2. **Authenticate your domain**: Settings → Sender Authentication →
   Authenticate Your Domain. Add the CNAME records it gives you at your DNS
   provider and verify.
3. Pick a secret string for `SENDGRID_INBOUND_TOKEN` (any long random value) and
   save it.
4. **Inbound Parse**: Settings → Inbound Parse → Add Host & URL.
   - **Receiving domain**: a subdomain you'll use for mail, e.g. subdomain
     `parse`, domain `yourdomain.com` → `parse.yourdomain.com`.
   - **Destination URL**:
     `https://<your-vercel-domain>/api/email/inbound?token=<SENDGRID_INBOUND_TOKEN>`
   - Leave **"POST the raw, full MIME message"** unchecked (we rely on the
     parsed `text` / `html` / `subject` / `headers` fields).
5. **Add the MX record** at your DNS provider for the receiving subdomain:
   - Host/name: `parse` (i.e. `parse.yourdomain.com`)
   - Type: `MX`, Priority: `10`, Value: `mx.sendgrid.net`
6. **Forward the newsletter** to any address at that subdomain (e.g.
   `news@parse.yourdomain.com`) — set a forwarding rule in Gmail/Outlook, or
   subscribe that address to the newsletter directly. Any mail to that subdomain
   gets parsed and POSTed to your webhook.

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
SENDGRID_INBOUND_TOKEN=
```

`SENDGRID_INBOUND_TOKEN` must be the exact same string you appended as `?token=`
on the SendGrid destination URL.

---

## 6. Install & deploy

This is a Next.js App Router project; the `@/` import alias maps to the project
root via `tsconfig.json`.

```bash
npm install @supabase/supabase-js @vercel/functions cheerio
npm install          # install everything from package.json
vercel --prod        # deploy
```

After the first deploy, plug your real Vercel domain into the SendGrid
destination URL and the Slack Request URL.

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

- **No double-sends.** The inbound route derives a stable message id (the
  email's RFC `Message-ID`, or a hash of subject+body if absent) and *claims* it
  in `processed_emails` before doing any work; the unique constraint makes a
  SendGrid retry a no-op. If summarization or fan-out then fails, the claim is
  released so the retry can re-run the full job.
- **SendGrid posts form-data.** The route reads `multipart/form-data` fields
  (`text`, `html`, `subject`, `headers`) rather than JSON. It prefers `text` and
  falls back to stripping `html` with cheerio.
- **Resilient fan-out.** A failure delivering one subscriber's DM is logged and
  skipped — it never aborts the rest.
- **Security.** SendGrid Inbound Parse isn't signable, so requests are checked
  against a shared `?token=` secret with constant-time comparison. Slack
  requests are verified with HMAC-SHA256 over the raw body plus a 5-minute
  timestamp window.
