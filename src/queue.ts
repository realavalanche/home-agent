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
  WEEKLY: "weekly-review", // Sunday 9pm IST per-user AI review
  MORNING: "morning-briefing", // 6:30am IST per-user good-morning + overdue
  NOTION_SYNC: "notion-sync", // reconcile the Postgres index with Notion edits/deletes
  MEAL_CHECKIN: "meal-checkin", // 3pm IST: settle tomorrow's meals if not already planned
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
  instance.on("error", (err: unknown) => logger.error("pg-boss error", { err: String(err) }));
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
