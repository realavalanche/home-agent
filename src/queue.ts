import { PgBoss } from "pg-boss";
import { config } from "./config.js";
import { logger } from "./logger.js";
import type { AuthorKey } from "./users.js";

/**
 * Single pg-boss instance shared by the web process (producer) and the worker
 * (consumer). Postgres-backed, so no Redis. Queues must be created before use.
 */
export const QUEUES = {
  INGEST: "ingest", // process one inbound WhatsApp message end-to-end
  SEND: "send-message", // fire a scheduled outbound/reminder WhatsApp message
  WEEKLY: "weekly-review", // per-user AI review — on demand only (Sunday cron retired)
  MORNING: "morning-briefing", // per-user good-morning — on demand only (6:30am cron retired)
  NOTION_SYNC: "notion-sync", // reconcile the Postgres index with Notion edits/deletes
  MEAL_CHECKIN: "meal-checkin", // retired 3pm meal check-in; kept only so boot can unschedule it
  KEEPALIVE: "keepalive", // hourly: ping before WhatsApp's 24h window closes
  ESCALATE: "escalate", // urgent reminder unread after 30min -> phone call
} as const;

/** Payload for an inbound message to process. Raw audio is never queued — only
 * the media id, which the worker downloads, transcribes, and discards. */
export interface IngestJob {
  waMessageId: string;
  fromPhone: string;
  type: "text" | "audio" | "image" | "document";
  text?: string; // for text messages
  mediaId?: string; // for voice notes, images, documents
  caption?: string; // optional caption on an image/document
  quotedId?: string; // WhatsApp id of a message the user replied to (quoted)
  timestamp: number;
}

/** Payload for a scheduled send (reminder to self or outbound to third party). */
export interface SendJob {
  scheduledId: number; // row in scheduled_messages
}

/** Payload for the weekly review job. */
export interface WeeklyJob {
  authorKey: AuthorKey;
}

let boss: PgBoss | undefined;

/** Get the started singleton. Safe to call from anywhere. */
export async function getBoss(): Promise<PgBoss> {
  if (boss) return boss;
  const instance = new PgBoss({ connectionString: config.DATABASE_URL });
  instance.on("error", (err: unknown) => {
    // A pg-boss error is usually a dropped DB connection. In the past this left
    // the message-processing worker silently dead for a day. Fail fast so Railway
    // restarts us with a fresh, polling worker instead of limping along.
    logger.error("pg-boss error — exiting to force a clean restart", { err: String(err) });
    process.exit(1);
  });
  await instance.start();
  await Promise.all(Object.values(QUEUES).map((q) => instance.createQueue(q)));
  boss = instance;
  return boss;
}

/** Enqueue an inbound message for processing (called from the webhook). */
export async function enqueueIngest(job: IngestJob): Promise<void> {
  const b = await getBoss();
  // singletonKey dedupes if Meta redelivers the same message id.
  await b.send(QUEUES.INGEST, job, { singletonKey: job.waMessageId });
}
