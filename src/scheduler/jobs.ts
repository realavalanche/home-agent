import type { Job } from "pg-boss";
import { logger } from "../logger.js";
import { config } from "../config.js";
import { getBoss, QUEUES, type IngestJob, type SendJob, type WeeklyJob } from "../queue.js";
import { query } from "../db/pool.js";
import { processIngest } from "../ingest.js";
import { sendText } from "../whatsapp/client.js";
import { markTaskDone } from "../notion/log.js";
import { runWeeklyReview } from "./weekly-review.js";
import { runMorningBriefing } from "./morning-briefing.js";
import { runNotionSync } from "./notion-sync.js";
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

  // 4) Morning briefing (one per user).
  await boss.work<WeeklyJob>(QUEUES.MORNING, async (jobs: Job<WeeklyJob>[]) => {
    for (const job of jobs) await runMorningBriefing(job.data.authorKey);
  });

  // 5) Notion → Postgres reconcile.
  await boss.work(QUEUES.NOTION_SYNC, async () => {
    await runNotionSync();
  });
  await boss.schedule(QUEUES.NOTION_SYNC, "*/20 * * * *", {}, { tz: config.TIMEZONE, key: "notion-sync" });

  // Cron: Sunday 21:00 IST → one weekly-review job per user (keyed schedules).
  // pg-boss cron is UTC unless tz is given; we pin it to the app timezone.
  for (const user of allUsers()) {
    await boss.schedule(
      QUEUES.WEEKLY,
      "0 21 * * 0",
      { authorKey: user.key } satisfies WeeklyJob,
      { tz: config.TIMEZONE, key: `weekly-${user.key}` }
    );
    // Daily good-morning briefing at 06:30 IST.
    await boss.schedule(
      QUEUES.MORNING,
      "30 6 * * *",
      { authorKey: user.key } satisfies WeeklyJob,
      { tz: config.TIMEZONE, key: `morning-${user.key}` }
    );
  }

  logger.info("scheduler + workers started", { tz: config.TIMEZONE });
}

/**
 * Send a scheduled message. One-time messages (status 'armed') are marked 'sent'
 * afterward; recurring reminders (status 'recurring') keep firing on their cron
 * and just record last_fired_at. Anything else (cancelled/sent) is skipped.
 */
async function dispatchScheduled(scheduledId: number): Promise<void> {
  const res = await query<{
    recipient: string;
    body: string;
    status: string;
    notion_task_id: string | null;
    auto_complete: boolean;
  }>(
    `SELECT recipient, body, status, notion_task_id, auto_complete
     FROM scheduled_messages WHERE id = $1`,
    [scheduledId]
  );
  const row = res.rows[0];
  if (!row) return;
  if (row.status !== "armed" && row.status !== "recurring") {
    logger.info("skip scheduled", { scheduledId, status: row.status });
    return;
  }
  await sendText(row.recipient, row.body);
  if (row.status === "recurring") {
    await query(`UPDATE scheduled_messages SET last_fired_at = now() WHERE id = $1`, [scheduledId]);
  } else {
    await query(`UPDATE scheduled_messages SET status = 'sent', last_fired_at = now() WHERE id = $1`, [
      scheduledId,
    ]);
    // A pure reminder is complete once delivered — close its task so it doesn't
    // linger as overdue. (Family/vaccination nudges have auto_complete = false.)
    if (row.auto_complete && row.notion_task_id) {
      await markTaskDone(row.notion_task_id).catch(() => {});
    }
  }
  logger.info("scheduled message sent", { scheduledId, to: row.recipient, recurring: row.status === "recurring" });
}
