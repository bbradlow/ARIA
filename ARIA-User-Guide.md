# Meet ARIA

**ARIA** (Activant Research Intelligence Assistant) is a Slack bot that does three things for the Activant team: it summarizes new research the moment it's published, answers questions about our past research, and looks up live deal and relationship data from our Affinity pipeline — all without leaving Slack.

Here's everything it can do and how to use it.

---

## 1. Automatic research summaries

Whenever a new Activant Capital research newsletter goes out, ARIA reads it, writes a short summary, and shares it — with a link back to the full piece.

**To get summaries in your DMs:** send ARIA a direct message that says `subscribe`. You'll get a DM summary every time a new issue is published. Send `unsubscribe` anytime to stop.

**To get summaries in a channel:** add ARIA to the channel (in the channel, use the "+"/integrations menu → *Add apps*, or type `/invite @ARIA`). From then on it posts each new summary there. Remove it from the channel to stop.

You don't have to do anything to "trigger" this — it happens on its own when new research lands.

---

## 2. Ask about past research

ARIA has read Activant's full research library and can answer questions from it, with links to the sources it used.

**In a channel:** @mention it with your question —
> @ARIA what have we written about stablecoins in payments?

**In a DM:** just ask the question directly (no mention needed).

It only answers from actual Activant research; if something isn't in the library, it'll tell you rather than guess.

---

## 3. Pipeline & relationship questions (Affinity)

ARIA can query our live Affinity data — deals, companies, people, and pipeline status — using the `$aff` command.

**In a channel or group DM:** @mention it and start your message with `$aff` —
> @ARIA $aff what's the latest activity on OpenMind?

**In a direct message:** just start with `$aff` (no mention needed) —
> $aff which opportunities are in our active pipeline?

It answers in the channel where you asked, and remembers the recent back-and-forth, so you can follow up naturally:
> $aff who's the owner on that one?

**Tip:** be specific. Asking about a named company, person, or deal ("$aff tell me about OpenMind") is fast; asking it to dump an entire list is slow and may time out. Name the thing you want.

---

## Quick reference

| What you want | Where | What to type |
|---|---|---|
| Get research summaries in DMs | DM to ARIA | `subscribe` |
| Stop summaries | DM to ARIA | `unsubscribe` |
| Get summaries in a channel | The channel | Add ARIA to it (`/invite @ARIA`) |
| Ask about past research | Channel | `@ARIA <your question>` |
| Ask about past research | DM | `<your question>` |
| Ask about the pipeline/CRM | Channel / group | `@ARIA $aff <your question>` |
| Ask about the pipeline/CRM | DM | `$aff <your question>` |
| See what ARIA can do | DM to ARIA | `help` |

---

## Good to know

- **Research vs. pipeline:** a plain question (no `$aff`) searches our *research library*; a question starting with `$aff` queries *Affinity*. The `$aff` prefix is what flips ARIA into CRM mode.
- **Why `$` and not `/`:** Slack treats messages beginning with `/` as slash commands, so `$` is used instead — that's also why `$aff` works in a DM without mentioning ARIA first.
- **Replies land in the channel,** not buried in a thread (unless you asked inside an existing thread).
- **Sources:** research answers include links so you can verify and read more.
