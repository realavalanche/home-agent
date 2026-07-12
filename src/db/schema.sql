-- home-agent schema. Applied idempotently by src/db/migrate.ts.
-- Requires the pgvector extension (bundled in the pgvector/pgvector image).

CREATE EXTENSION IF NOT EXISTS vector;

-- Every capture (voice or text) after transcription. Notion is the human record;
-- this is the machine index used for search, auto-linking, and the weekly review.
CREATE TABLE IF NOT EXISTS captures (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  wa_message_id   TEXT UNIQUE,                 -- idempotency: Meta retries webhooks
  author_key      TEXT NOT NULL,               -- 'A' | 'B'
  author_name     TEXT NOT NULL,
  source          TEXT NOT NULL,               -- 'voice' | 'text'
  language_code   TEXT,                        -- e.g. hi-IN, en-IN
  transcript      TEXT NOT NULL,
  category        TEXT,                         -- Shopping|Meals|Ideas|Work|Personal|Family|Tasks
  subcategory     TEXT,                         -- Breakfast|Lunch|Dinner for Meals
  notion_page_id  TEXT,
  embedding       vector(1024),                -- voyage-3 dimension
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Approx nearest-neighbour index for semantic search + auto-link.
CREATE INDEX IF NOT EXISTS captures_embedding_idx
  ON captures USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS captures_author_created_idx
  ON captures (author_key, created_at DESC);

-- Shared meal plan, one row per date. Dinner defaults to lunch unless set.
-- A plan is 'proposed' by one partner and becomes 'confirmed' once the other
-- agrees — the 3pm check-in only asks when a date isn't settled yet.
CREATE TABLE IF NOT EXISTS meal_plans (
  plan_date    DATE PRIMARY KEY,
  breakfast    TEXT,
  lunch        TEXT,            -- the sabzi
  dinner       TEXT,            -- NULL => same as lunch
  proposed_by  TEXT,            -- 'A' | 'B'
  confirmed_by TEXT,            -- 'A' | 'B' (the partner who agreed)
  status       TEXT NOT NULL DEFAULT 'proposed', -- proposed | confirmed
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every message WE send out (replies, reminders, briefings), keyed by its
-- WhatsApp message id. Needed so that when the user REPLIES to one of our
-- messages, we can resolve what they were quoting (Meta only sends the id).
CREATE TABLE IF NOT EXISTS outbound_messages (
  wa_message_id TEXT PRIMARY KEY,
  recipient     TEXT NOT NULL,
  body          TEXT NOT NULL,
  status        TEXT,            -- sent | delivered | read | failed (from Meta status webhooks)
  status_at     TIMESTAMPTZ,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE outbound_messages ADD COLUMN IF NOT EXISTS status    TEXT;
ALTER TABLE outbound_messages ADD COLUMN IF NOT EXISTS status_at TIMESTAMPTZ;
ALTER TABLE outbound_messages ADD COLUMN IF NOT EXISTS error     TEXT;

-- Durable long-term facts the assistant should remember indefinitely: contact
-- numbers, birthdays, addresses, preferences, important dates. Household-shared
-- (both users). Embedded for semantic recall months later.
CREATE TABLE IF NOT EXISTS facts (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  content     TEXT NOT NULL,               -- e.g. "Arpita's phone is 9973499229"
  embedding   vector(1024),
  added_by    TEXT,                         -- 'A' | 'B'
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS facts_embedding_idx
  ON facts USING hnsw (embedding vector_cosine_ops);

-- Short-term conversation memory so the agent can follow a multi-message thread
-- (e.g. "message Arpita" → later a number → later the text). One row per turn.
CREATE TABLE IF NOT EXISTS conversation_turns (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  author_key  TEXT NOT NULL,
  role        TEXT NOT NULL,   -- 'user' | 'assistant'
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversation_turns_author_idx
  ON conversation_turns (author_key, created_at DESC);

-- Per-user Google OAuth tokens (two users). Stores the refresh token so we can
-- act on their calendar/gmail without re-consent.
CREATE TABLE IF NOT EXISTS google_tokens (
  author_key    TEXT PRIMARY KEY,             -- 'A' | 'B'
  email         TEXT,
  access_token  TEXT,
  refresh_token TEXT NOT NULL,
  scope         TEXT,
  expiry_date   BIGINT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Outbound scheduled WhatsApp messages (to the sender = reminders, or to a
-- third party = "message Rohit tomorrow"). Armed only after confirmation for
-- third-party recipients. pg-boss handles the actual timed dispatch; this table
-- is the human-auditable record + confirmation state.
CREATE TABLE IF NOT EXISTS scheduled_messages (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  author_key    TEXT NOT NULL,
  recipient     TEXT NOT NULL,                -- E.164 digits
  body          TEXT NOT NULL,
  send_at       TIMESTAMPTZ NOT NULL,
  kind          TEXT NOT NULL,               -- 'reminder' | 'outbound'
  status        TEXT NOT NULL DEFAULT 'pending', -- pending|awaiting_confirm|armed|sent|cancelled|recurring
  job_id        TEXT,                        -- pg-boss job id once armed
  notion_task_id TEXT,                       -- linked Notion Task page (reminders)
  recurrence    TEXT,                        -- pg-boss cron for recurring reminders; null = one-time
  schedule_key  TEXT,                        -- pg-boss schedule key for recurring reminders
  last_fired_at TIMESTAMPTZ,                 -- last time a (recurring) reminder fired
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotent column adds so this applies to an already-created table.
ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS notion_task_id TEXT;
ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS recurrence    TEXT;
ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS schedule_key  TEXT;
ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS last_fired_at TIMESTAMPTZ;
-- Pure reminders auto-complete their linked task once fired (a nudge is done when
-- delivered). Family/vaccination nudges keep their task open.
ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS auto_complete BOOLEAN NOT NULL DEFAULT false;
-- Urgent / "call me" / alarm-style reminders ring the phone instead of just messaging.
ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS via_call BOOLEAN NOT NULL DEFAULT false;
