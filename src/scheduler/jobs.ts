import type { Job } from "pg-boss";
import { logger } from "../logger.js";
import { config } from "../config.js";
import { getBoss, QUEUES, type IngestJob, type SendJob, type WeeklyJob } from "../queue.js";
import { query } from "../db/pool.js";
import { processIngest } from "../ingest.js";
import { sendText } from "../whatsapp/client.js";
import { runWeeklyReview } from "./weekly-review.js";
import { allUsers } from "../users.js";

/**
 * Boot the background workers + cron schedules. Runs in the same process as the
 * web server. pg-boss handles concurrency, retries, and delayed/cron jobs.
 */
export async function startScheduler(): Promise<void> {
  const boss = await getBoss();

  // 1) Inbound message processing.
  await boss.work<IngestJob>(QUEUES.INGEST, async (jobs: Job<IngestJob>[]) => {
    for (const job of jobs) await processIngest(job.data);
  });

  // 2) Scheduled sends (reminders to self + confirmed outbound to others).
  await boss.work<SendJob>(QUEUES.SEND, async (jobs: Job<SendJob>[]) => {
    for (const job of jobs) await dispatchScheduled(job.data.scheduledId);
  });

  // 3) Weekly review fan-out job (one per user).
  await boss.work<WeeklyJob>(QUEUES.WEEKLY, async (jobs: Job<WeeklyJob>[]) => {
    for (const job of jobs) await runWeeklyReview(job.data.authorKey);
  });

  // Cron: Sunday 21:00 IST → one weekly-review job per user (keyed schedules).
  // pg-boss cron is UTC unless tz is given; we pin it to the app timezone.
  for (const user of allUsers()) {
    await boss.schedule(
      QUEUES.WEEKLY,
      "0 21 * * 0",
      { authorKey: user.key } satisfies WeeklyJob,
      { tz: config.TIMEZONE, key: `weekly-${user.key}` }
    );
  }

  logger.info("scheduler + workers started", { tz: config.TIMEZONE });
}

/** Send a scheduled message if it is still armed, then mark it sent. */
async function dispatchScheduled(scheduledId: number): Promise<void> {
  const res = await query<{ recipient: string; body: string; status: string }>(
    `SELECT recipient, body, status FROM scheduled_messages WHERE id = $1`,
    [scheduledId]
  );
  const row = res.rows[0];
  if (!row) return;
  if (row.status !== "armed") {
    logger.info("skip scheduled (not armed)", { scheduledId, status: row.status });
    return;
  }
  await sendText(row.recipient, row.body);
  await query(`UPDATE scheduled_messages SET status = 'sent' WHERE id = $1`, [scheduledId]);
  logger.info("scheduled message sent", { scheduledId, to: row.recipient });
}
