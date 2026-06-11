# Activant Research Slack Bot

Monitors [activantcapital.com/research](https://activantcapital.com/research) every 30
minutes, detects newly published articles, summarizes each with Claude (via
OpenRouter), and DMs every subscriber a summary in Slack. Users opt in/out by
DMing the bot `subscribe` / `unsubscribe`.

- **Vercel Cron** → scrape, detect new, summarize, fan out DMs
- **Appwrite** → seen-article log + subscriber list
- **OpenRouter** → summarization (`anthropic/claude-sonnet-4-5`)
- **Slack Events API** → handles inbound DM commands

## Project layout

```
app/api/slack/events/route.ts   Inbound DM handler (subscribe / unsubscribe)
app/api/cron/route.ts           Cron handler (scrape, summarize, DM)
lib/appwrite.ts                 Appwrite client singleton + helpers
lib/slack.ts                    chat.postMessage / DM helper
lib/scrape.ts                   Listing + article-body scraping (cheerio)
lib/summarize.ts                OpenRouter summarization call
vercel.json                     Cron schedule
```

## 1. Appwrite

Create a project at [cloud.appwrite.io](https://cloud.appwrite.io) (or use a
self-hosted instance), then set up the data model. The current Appwrite console
labels this **TablesDB** (tables / columns / rows); older docs call it
**Databases** (collections / attributes / documents). They're the same thing and
map 1:1 — this app uses the `Databases` server SDK, which works against either.
Whichever the console shows, create:

**A database** — note its ID (e.g. `research`).

**Collection / table `articles`** with these attributes (columns):

| Key | Type | Size | Required |
|---|---|---|---|
| `url` | String | 2000 | yes |
| `title` | String | 1024 | no |

**Collection / table `subscribers`** with:

| Key | Type | Size | Required |
|---|---|---|---|
| `slack_user_id` | String | 64 | yes |

No indexes are required: the app uses deterministic document IDs (a hash of the
article URL for `articles`, and the Slack user ID itself for `subscribers`), so
uniqueness is enforced by the ID. Appwrite's built-in `$createdAt` covers the
"when" — there's no separate timestamp attribute to create.

Then create a **server API key** (Overview → your project → API keys, or
Settings) with **`databases.read`** and **`databases.write`** scopes. Copy:

- Endpoint — **region-specific**, e.g. `https://nyc.cloud.appwrite.io/v1` (Settings page) → `APPWRITE_ENDPOINT`
- Project ID → `APPWRITE_PROJECT_ID`
- API key secret → `APPWRITE_API_KEY`
- Database ID → `APPWRITE_DATABASE_ID`
- Collection IDs → `APPWRITE_ARTICLES_COLLECTION_ID`, `APPWRITE_SUBSCRIBERS_COLLECTION_ID`

The API key is secret and server-only — never expose it to the browser.

## 2. Slack app

Create an app at <https://api.slack.com/apps> → *From scratch*.

**OAuth & Permissions → Bot Token Scopes:**

| Scope | Why |
|---|---|
| `chat:write` | send DMs |
| `im:history` | receive `message.im` events |
| `im:write` | open DM channels |
| `users:read` | resolve user info if needed |

Install to the workspace, then copy the **Bot User OAuth Token** (`xoxb-...`) into
`SLACK_BOT_TOKEN` and the **Signing Secret** (Basic Information) into
`SLACK_SIGNING_SECRET`.

**Event Subscriptions:** enable, set the Request URL to
`https://<your-vercel-domain>/api/slack/events`, and subscribe to the **bot event**
`message.im`. Slack will hit the URL with a `url_verification` challenge — the route
echoes it back automatically, so deploy *before* saving the URL (or save, then
redeploy and re-verify). Reinstall the app if you add scopes later.

## 3. Environment variables

Copy `.env.example` → `.env.local` for local dev, and add the same keys in Vercel
(Project → Settings → Environment Variables):

```
APPWRITE_ENDPOINT=https://<region>.cloud.appwrite.io/v1
APPWRITE_PROJECT_ID=
APPWRITE_API_KEY=
APPWRITE_DATABASE_ID=research
APPWRITE_ARTICLES_COLLECTION_ID=articles
APPWRITE_SUBSCRIBERS_COLLECTION_ID=subscribers
OPENROUTER_API_KEY=
SLACK_BOT_TOKEN=
SLACK_SIGNING_SECRET=
CRON_SECRET=        # e.g. `openssl rand -hex 32`
```

When `CRON_SECRET` is set, Vercel Cron automatically attaches
`Authorization: Bearer <CRON_SECRET>` to its requests; the route rejects anything else.

## 4. Install & deploy

```bash
npm install
vercel --prod
```

Set the env vars in Vercel before (or immediately after) the first deploy, then
redeploy so they take effect.

## Testing

- **Cron locally / manually:**
  ```bash
  curl -H "Authorization: Bearer $CRON_SECRET" https://<your-domain>/api/cron
  ```
  Returns `{ "checked": N, "posted": M, "subscribers": S }`.
- **Slack:** DM the bot `subscribe`, then trigger the cron — you should get a DM for
  any article not yet recorded. To replay an article, delete its row/document in the
  Appwrite console.
- **First run note:** on the very first run *every* article on the page counts as
  "new". To avoid blasting subscribers (and a large OpenRouter bill) on day one,
  run the cron once with zero subscribers so it records the backlog silently, then
  subscribe.

## Design notes & caveats

- **Scraping is URL-pattern based, not XPath.** The spec's positional XPath
  (`/html/body/div/main/div[3]/…`) breaks on any layout change. Instead the scraper
  collects every `/research/<slug>` link, which is stable as long as article URLs
  keep that shape. If the site ever moves to client-side rendering, plain `fetch`
  would return an empty shell and you'd need a headless browser (e.g. Playwright) or
  the site's underlying data/API. As of this writing the pages are server-rendered.
- **Deterministic IDs = dedup without indexes.** Each article's document ID is a hash
  of its URL, and each subscriber's document ID is their Slack user ID. `createDocument`
  therefore acts as an atomic claim: a duplicate insert throws a 409, which the code
  treats as "already seen" / "already subscribed". This is also why no unique index is
  needed.
- **Record-before-fanout (intentional spec deviation).** The cron records an article
  before DMing subscribers. This prevents a crash mid-fanout from re-sending to
  everyone on the next run. The downside: if Slack is fully down during fanout, that
  article is skipped permanently. For true exactly-once delivery, add a `deliveries`
  collection keyed on `{article_id}_{slack_user_id}` and DM only recipients without a
  document, creating one as you go.
- **Subscriber list cap.** The cron reads up to 1000 subscribers in one query
  (`Query.limit(1000)`). Beyond that, paginate with `Query.offset` / cursor queries.
- **Vercel plan limits.** A `*/30` cron and the 300s `maxDuration` require a **paid
  plan**. On the **Hobby** plan, cron jobs run at most **once per day** and functions
  time out at **60s** — adjust `vercel.json` to a daily schedule and lower
  `maxDuration` if you're on Hobby.
- **Per-article failures are isolated.** A bad scrape, summary, or DM is logged and
  skipped; it never aborts the whole run.
- **Signature verification** uses constant-time HMAC comparison plus a 5-minute
  timestamp window (replay protection). Requests without a valid signature get `403`.
