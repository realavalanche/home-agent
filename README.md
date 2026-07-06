# home-agent

A bilingual (English / Hindi / **Hinglish**) WhatsApp personal assistant for two people
(you + your wife) on a single shared WhatsApp Business number.

Send it a **voice note or text** and it will:

- **Transcribe** voice (Sarvam — handles mid-sentence Hindi↔English code-switching) and **reply in the same language**.
- **Know who sent it** (by WhatsApp number) and route/store per user. Unknown senders get a polite refusal.
- **Auto-categorize** every capture → Shopping · Meals (Breakfast/Lunch/Dinner) · Ideas · Work · Personal · Family · Tasks.
- **Log to Notion** (your long-term brain) and **auto-link related past notes**.
- For **Ideas**, extract 1–3 concrete next actions as linked **Tasks**.
- **Semantic search** across everything ("what did I say about the Goa trip?").
- **Google Calendar** create / update / delete with reminders — each user's own calendar.
- **Gmail** search / summarize / **draft** (never auto-sends).
- **Schedule WhatsApp** messages: reminders back to you, or a message to someone else at a set time (with a confirm step first).
- **Weekly review** every Sunday 9pm IST: per-user AI summary → Notion + WhatsApp.

## Architecture (one process, one Postgres, no Redis)

```
WhatsApp ─▶ Fastify /webhook ─(verify HMAC sig, 200 ack, enqueue)─▶ pg-boss (Postgres)
                                                                       │
   ingest worker: download audio ▶ Sarvam STT ▶ identify user ▶ Claude agent(tools) ▶ reply
                                                       │
   tools: log_capture(Notion + pgvector) · calendar CRUD · semantic_search ·
          schedule_reminder / schedule_outbound · gmail search/draft · confirm/cancel
                                                       ▲
   pg-boss cron/delayed: scheduled sends · reminders · Sunday 9pm IST weekly review
```

- **Language/runtime:** TypeScript + Node 20+, Fastify.
- **AI:** Claude (`claude-sonnet-5` for the agent, `claude-opus-4-8` for weekly reviews) · Sarvam STT · Voyage `voyage-3` embeddings.
- **Data:** Notion = human record. Postgres + **pgvector** = search index + job queue (pg-boss). Raw audio is transcribed in memory and **never stored**.

---

## Setup order (do these in sequence)

### 0. Credentials to gather first

| Env var | What / where |
|---|---|
| `WHATSAPP_PHONE_NUMBER_ID` | Meta — you already have it |
| `WHATSAPP_ACCESS_TOKEN` | Meta — your permanent token |
| `WHATSAPP_APP_SECRET` | Meta App → Settings → Basic (needed for webhook signature check) |
| `WHATSAPP_VERIFY_TOKEN` | **You invent** any random string |
| `USER_A_WHATSAPP`, `USER_B_WHATSAPP` | your + your wife's personal numbers, digits only (e.g. `9199…`) |
| `NOTION_TOKEN` | notion.so/my-integrations → new internal integration |
| `NOTION_PARENT_PAGE_ID` | a Notion page **shared** with that integration (⋯ → Connections) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google Cloud Console → OAuth client (Web). Enable **Calendar API** + **Gmail API** |
| `GOOGLE_REDIRECT_URI` | `PUBLIC_BASE_URL` + `/oauth/google/callback` (add it as an Authorized redirect URI) |
| `ANTHROPIC_API_KEY` | console.anthropic.com |
| `SARVAM_API_KEY` | sarvam.ai |
| `VOYAGE_API_KEY` | voyageai.com |

### 1. Configure

```bash
cp .env.example .env      # then fill in the values above
npm install
```

### 2. Start Postgres + apply schema

**Local:** `docker compose up -d db` (uses the pgvector image), then:

```bash
npm run migrate           # creates tables + pgvector index
```

### 3. Provision the Notion databases (one time)

```bash
npm run setup:notion      # creates Captures / Tasks / Weekly Reviews under your parent page
```

This writes the resulting database + data-source ids back into `.env` automatically.

### 4. Run the app + expose it over HTTPS

```bash
npm run dev               # boots web + worker on :8080
# in another terminal, expose it (Meta needs a public HTTPS URL):
cloudflared tunnel --url http://localhost:8080     # or: ngrok http 8080
```

Set `PUBLIC_BASE_URL` (and `GOOGLE_REDIRECT_URI`) in `.env` to that HTTPS URL and restart `npm run dev`.

### 5. Register the Meta webhook

In your Meta app → WhatsApp → Configuration → Webhook:
- **Callback URL:** `PUBLIC_BASE_URL/webhook`
- **Verify token:** the `WHATSAPP_VERIFY_TOKEN` you chose
- Subscribe to the **messages** field.

### 6. Connect each user's Google (one time each)

```bash
npm run auth:google       # prints a consent link per user
```

You open the User A link and sign into **your** Google account; your wife opens the User B link and signs into **hers**. Calendar + Gmail tools go live per person.

### 7. Test without WhatsApp

```bash
npm run test:webhook -- "Idea: plan a Goa trip in December, book flights and a villa"
# sends a correctly-signed fake message as USER_A. Check Notion + your WhatsApp reply.
# send as the other user:  SENDER=<userB digits> npm run test:webhook -- "kal doodh laana hai"
```

---

## Local dev command

```bash
docker compose up -d db && npm run dev
```

## Deploy command (Fly.io)

```bash
fly launch --no-deploy                 # uses fly.toml (region bom / Mumbai)
fly postgres create                    # then: fly postgres attach <db-app>   (sets DATABASE_URL)
fly secrets set \
  WHATSAPP_PHONE_NUMBER_ID=… WHATSAPP_ACCESS_TOKEN=… WHATSAPP_APP_SECRET=… WHATSAPP_VERIFY_TOKEN=… \
  NOTION_TOKEN=… NOTION_PARENT_PAGE_ID=… NOTION_DB_CAPTURES=… NOTION_DS_CAPTURES=… \
  NOTION_DB_TASKS=… NOTION_DS_TASKS=… NOTION_DB_WEEKLY=… NOTION_DS_WEEKLY=… \
  GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… GOOGLE_REDIRECT_URI=… \
  ANTHROPIC_API_KEY=… SARVAM_API_KEY=… VOYAGE_API_KEY=… \
  PUBLIC_BASE_URL=https://home-agent.fly.dev USER_A_NAME=… USER_A_WHATSAPP=… USER_B_NAME=… USER_B_WHATSAPP=…
fly deploy                             # migrations run automatically on boot
```

Then point the Meta webhook + Google redirect URI at `https://home-agent.fly.dev`.
(The Docker image is host-agnostic — Railway / Render / a VPS work the same way; just provide a
pgvector-enabled Postgres and set the same env vars.)

---

## Design decisions & safety

- **Sarvam over Whisper** — trained on Indian audio; keeps accuracy across Hindi↔English switches and returns a language tag used for same-language replies.
- **Gmail is draft-only.** The app never calls `messages.send`; it prepares drafts for you to review.
- **Third-party WhatsApp sends require confirmation.** "Message Rohit tomorrow" is parked as `awaiting_confirm`; it only arms after you reply to confirm — so a mis-transcribed number can't message a stranger.
- **Shared Notion databases with an `Author` property** (not duplicated per person) — enables cross-person auto-linking and a single search index. Calendars stay separate via per-user OAuth.
- **Idempotent ingest** keyed on the WhatsApp message id (Meta retries webhooks).
- **No raw audio at rest** — voice bytes are transcribed in memory and discarded.

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | web + worker (watch mode) |
| `npm run build` / `npm start` | compile / run production build |
| `npm run migrate` | apply `src/db/schema.sql` |
| `npm run setup:notion` | create Notion databases, write ids to `.env` |
| `npm run auth:google` | print per-user Google consent links |
| `npm run test:webhook -- "text"` | send a signed fake inbound message locally |
| `npm run typecheck` | `tsc --noEmit` |
