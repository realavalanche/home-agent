<!--
  This is the ORIGINAL v1 design plan (the approved build spec), kept for
  historical/design context. The app has since grown well beyond it. Added after v1:
    - Durable facts memory (remember/recall: contact numbers, birthdays, etc.)
    - Short-term conversational memory (multi-message threads)
    - First-class reminders: recurring, snooze, mark-done, auto-complete-on-fire
    - Delete / edit / undo notes; running shopping list
    - Image & PDF capture via Claude vision
    - Calendar read-back ("what's on my calendar tomorrow?")
    - 6:30am morning briefing + overdue-task handling
    - Notion -> Postgres reconcile sync (edits/deletes keep search accurate)
    - Family tracker + India child immunization schedule
    - Deployed on Railway (pgvector Postgres); Google = Calendar only (Gmail deferred)
  See README.md for current setup and the live feature list.
-->

# Home-Agent — WhatsApp Personal Assistant (for you + your wife)

## Context
You want a shared WhatsApp Business number to act as a bilingual (English/Hindi/Hinglish) personal
assistant for two people. It must transcribe voice notes, know who sent them, auto-categorize every
capture, log to Notion (long-term brain), manage each person's Google Calendar, do semantic search
and auto-linking over past notes, extract next-actions from ideas, schedule outbound WhatsApp
messages + reminders, and produce a weekly AI review. The `home-agent/` folder is currently an empty
placeholder (`README.md` only), so this is a green-field build.

---

## What I'll build (the 5-bullet version)
1. **Ingest pipeline** — Meta Cloud API webhook (signature-verified, instant 200 ack) → job queue →
   download audio → **Sarvam** transcription → identify sender → **Claude agent** categorizes, logs
   to Notion, embeds for search, auto-links related notes, and replies in the user's own language.
2. **Claude tool-using agent** — one agent loop per message with tools: `log_capture`,
   `create/update/delete_calendar_event`, `semantic_search`, `schedule_whatsapp`, `set_reminder`,
   `extract_actions`, `search_gmail`. Handles both "capture this" and "do this / answer this".
3. **Notion as system of record** — setup script provisions all category databases via API; every
   capture is a page with author, category, transcript, language, and relations to related notes.
4. **Scheduler** — Postgres-backed jobs for outbound WhatsApp at a future time, reminders back to the
   sender, and the **Sunday 9pm IST weekly review** (per-user summary → Notion + WhatsApp).
5. **Google + Gmail integration** — per-user OAuth (two separate token sets) for Calendar (CRUD) and
   Gmail (search/summarize/draft). Setup script + README + local dev and deploy commands.

## Credentials you need to have ready
| # | Credential | Where from | Notes |
|---|-----------|-----------|-------|
| 1 | WhatsApp **Phone Number ID** | Meta (you have it) | ✓ |
| 2 | WhatsApp **permanent access token** | Meta (you have it) | ✓ |
| 3 | **App Secret** | Meta App → Settings → Basic | **Required** for webhook signature check |
| 4 | **Webhook verify token** | you invent a random string | used once to verify the webhook |
| 5 | WhatsApp Business Account ID | Meta | for sends |
| 6 | Your + your wife's **personal WhatsApp numbers** | you | sender identification |
| 7 | **Notion** internal integration token | notion.so/my-integrations | share the parent page with it |
| 8 | **Notion parent page ID** | a page in your workspace | databases get created under it |
| 9 | **Google OAuth client ID + secret** | Google Cloud Console | enable Calendar API + Gmail API |
| 10 | **Sarvam AI API key** | sarvam.ai | transcription (Saarika/Saaras) |
| 11 | **Anthropic API key** | console.anthropic.com | the agent brain (Claude) |
| 12 | **Voyage AI API key** | voyageai.com | multilingual embeddings for search |
| 13 | (prod) **Postgres URL** | your host | local uses docker-compose automatically |

Items 3, 5, 7, 8, 9, 10, 11, 12 are the ones you likely still need to grab. Google requires a one-time
OAuth consent per user (a link the app prints); I'll build that flow.

---

## Stack & non-obvious choices
- **TypeScript + Node 20, Fastify.** One language for webhook, agent, and jobs; Fastify makes raw-body
  HMAC signature verification clean. (You work in JS/Next, so this stays familiar.)
- **Transcription: Sarvam `saarika:v2.5` / `saaras:v3` (codemix mode).** Researched vs Whisper/Deepgram/
  ElevenLabs — Sarvam is trained on 1M+ hrs Indian audio and keeps accuracy across mid-sentence Hindi↔
  English switches, and returns a `language_code` I use to reply in the same language. This is the single
  biggest quality lever and a better default than the Whisper path.
- **Claude as an agent, not an if/else router.** Opus 4.8 for the weekly review + action extraction;
  Sonnet 5 for per-message categorization/tool-calling (fast + cheap). Structured output via tool-use.
- **Postgres + pgvector + pg-boss — one datastore, no Redis.** pgvector holds embeddings for semantic
  search; pg-boss gives cron + scheduled/delayed jobs (outbound WhatsApp, reminders, weekly review) on
  the same DB. Notion is the human-facing record; Postgres is the machine index + queue.
- **Embeddings: Voyage `voyage-3` (multilingual).** Anthropic-recommended and handles Hinglish notes
  better than English-only embedders.
- **Deploy: Docker (host-agnostic) + docker-compose for local; a `fly.toml` as the concrete deploy
  target.** One always-on machine runs web+worker; Fly/Railway/Render all work. Local webhook exposure
  via `cloudflared`/`ngrok` (documented).

## Architecture
```
WhatsApp ──▶ Fastify /webhook ──(verify sig, 200 ack, enqueue)──▶ pg-boss
                                                                     │
                          ┌──────────────────────────────────────────┘
                          ▼
                   ingest worker:
   download media ▶ Sarvam STT ▶ identify user ▶ Claude agent(tools) ▶ reply (same language)
                                                     │
        tools: log_capture(Notion+pgvector) · calendar CRUD · semantic_search ·
               schedule_whatsapp · set_reminder · extract_actions · search_gmail
                          ▲
   pg-boss cron/scheduled: outbound sends · reminders · Sun 9pm IST weekly review
```
Unknown sender → polite rejection, no processing. Idempotency keyed on WhatsApp message id (Meta retries).
Raw audio is deleted immediately after transcription (only transcript persists). If the agent will take
>~3s, an immediate "Got it, working on it…" ack goes out first.

## File layout (home-agent/)
```
src/
  index.ts                 # Fastify app: /webhook (GET verify, POST receive), /oauth callback, /health
  config.ts                # env loading + validation (zod)
  whatsapp/
    verify.ts              # X-Hub-Signature-256 HMAC check (raw body)
    client.ts              # send text / mark-read via Cloud API
    media.ts               # download audio by media id, hand bytes to STT, never persist
  transcribe/sarvam.ts     # Sarvam STT (codemix), returns {text, language_code}
  users.ts                 # phone → {name, notionAuthor, googleTokens}; unknown → reject
  agent/
    run.ts                 # Claude agent loop (Sonnet 5) with tool dispatch
    tools.ts               # tool schemas + handlers
    prompts.ts             # system prompt, language mirroring, category rubric
  categorize.ts            # category enum + rubric (Shopping/Meals/Ideas/Work/Personal/Family/Tasks)
  notion/
    client.ts              # thin wrapper (API version 2025-09-03, data sources)
    log.ts                 # write capture page, set relations (auto-link), create linked Tasks
  search/
    embed.ts               # Voyage embeddings
    store.ts               # pgvector upsert + kNN query (auto-link + semantic search)
  google/
    auth.ts                # per-user OAuth (2 token sets), refresh, storage
    calendar.ts            # create/update/delete events + reminders
    gmail.ts               # search / summarize / draft (no auto-send)
  scheduler/
    jobs.ts                # pg-boss registration
    outbound.ts            # send scheduled WhatsApp to any recipient
    reminders.ts           # reminders back to sender
    weekly-review.ts       # Sun 9pm IST: per-user summary → Notion + WhatsApp
  db/
    schema.sql             # captures, embeddings(pgvector), google_tokens, scheduled_messages
    migrate.ts             # apply schema.sql
scripts/
  setup-notion.ts          # provision all Notion databases under parent page (idempotent)
  google-auth.ts           # CLI to walk each user through OAuth once
Dockerfile · docker-compose.yml · fly.toml · .env.example · README.md · package.json · tsconfig.json
```

## Data model
**Notion databases** (created by `setup-notion.ts` under your parent page):
- **Captures** (hub): Title, Author (select: you/wife), Category (select), Subcategory (Meals→
  Breakfast/Lunch/Dinner), Transcript, Language, Source (voice/text), Related (relation → Captures),
  Created.
- **Tasks**: Title, Author, Status, Due, Source Idea (relation → Captures).
- **Ideas**, **Shopping**, **Meals**, **Family**, **Work/Personal** captured as Captures rows filtered
  by Category, plus a **Weekly Reviews** database. (Shared DBs with an Author property — enables
  cross-person linking and a single search index; per-user views come from filters. Calendars stay
  fully separate via per-user OAuth.)

**Postgres**: `captures` (mirror + embedding_id), `embeddings` (vector, pgvector), `google_tokens`
(per user, refresh token), `scheduled_messages` (recipient, body, send_at, status), pg-boss tables.

## Build phases (each ends with a typecheck/run checkpoint)
1. Scaffold: package.json, tsconfig, config+zod, Docker/compose, `.env.example`, health route. → `tsc` + boot.
2. WhatsApp webhook: GET verify + POST receive, signature check, 200 ack, enqueue. → curl a signed payload.
3. Transcription + user id + reply. → unit-run Sarvam on a sample OGG; reply echo.
4. Notion setup script + `log_capture`. → run script, confirm DBs + a test row.
5. Search: Voyage embed + pgvector store + `semantic_search` + auto-link on ingest. → query test.
6. Claude agent loop + categorization + Ideas→Tasks extraction. → end-to-end capture.
7. Google OAuth + Calendar CRUD + Gmail search/draft tools. → create/delete a real event.
8. Scheduler: outbound WhatsApp, reminders, weekly review cron. → schedule a +2min send.
9. Deploy config polish + README with exact setup order, local dev + deploy commands.

## Verification
- `docker compose up` boots Postgres + app; `/health` green.
- Signed test webhook (script) → row appears in Notion + Postgres, reply received.
- Sample Hinglish voice note transcribes correctly and reply is in matching language.
- `semantic_search("Goa trip")` returns seeded related notes; auto-link relation set on Notion page.
- "remind me to WhatsApp Rohit in 2 minutes saying hi" → message sent at T+2min from business number.
- Manually trigger weekly-review job → summary in Notion + WhatsApp.
- Unknown number → polite rejection, nothing logged.

## Decisions I'm making (tell me to change any)
- **Gmail is read/search/summarize + draft only — never auto-sends.** Safer default for an assistant.
- **Third-party scheduled WhatsApp sends** ("message Rohit…") get a **confirmation reply** before the
  scheduled send is armed, so a mis-transcription can't message someone unintended.
- **Shared Notion databases with an Author property** (not duplicated per person).
- **Fly.io** as the written deploy example (Docker means Railway/Render/VPS work identically).
- All times **IST**.
