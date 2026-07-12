import type { Job } from "pg-boss";
import { logger } from "../logger.js";
import { config } from "../config.js";
import { getBoss, QUEUES, type IngestJob, type SendJob, type WeeklyJob } from "../queue.js";
import { query } from "../db/pool.js";
import { processIngest } from "../ingest.js";
import { sendText } from "../whatsapp/client.js";
import { markTaskDone } from "../notion/log.js";
import { placeCall, callingEnabled } from "../call.js";
import { runWeeklyReview } from "./weekly-review.js";
import { runMorningBriefing } from "./morning-briefing.js";
import { runNotionSync } from "./notion-sync.js";
import { runMealCheckin } from "./meal-checkin.js";
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

  // 3) Weekly HOUSEHOLD review — one summary, delivered to both partners.
  await boss.work(QUEUES.WEEKLY, async () => {
    await runWeeklyReview();
  });
  await boss.schedule(QUEUES.WEEKLY, "0 21 * * 0", {}, { tz: config.TIMEZONE, key: "weekly-household" });

  // 4) Morning briefing (one per user).
  await boss.work<WeeklyJob>(QUEUES.MORNING, async (jobs: Job<WeeklyJob>[]) => {
    for (const job of jobs) await runMorningBriefing(job.data.authorKey);
  });

  // 5) Notion → Postgres reconcile.
  await boss.work(QUEUES.NOTION_SYNC, async () => {
    await runNotionSync();
  });
  await boss.schedule(QUEUES.NOTION_SYNC, "*/20 * * * *", {}, { tz: config.TIMEZONE, key: "notion-sync" });

  // 6) Meal check-in for tomorrow, daily at 15:00 IST (skips if already settled).
  await boss.work(QUEUES.MEAL_CHECKIN, async () => {
    await runMealCheckin();
  });
  await boss.schedule(QUEUES.MEAL_CHECKIN, "0 15 * * *", {}, { tz: config.TIMEZONE, key: "meal-checkin" });

  // The weekly review used to be scheduled per-user (keys weekly-A / weekly-B).
  // Those schedules persist in the DB, so remove them — otherwise they'd fire
  // alongside the new household schedule and send the review multiple times.
  for (const user of allUsers()) {
    await boss.unschedule(QUEUES.WEEKLY, `weekly-${user.key}`).catch(() => {});
  }

  // pg-boss cron is UTC unless tz is given; we pin it to the app timezone.
  for (const user of allUsers()) {
    // Daily good-morning briefing at 06:30 IST (stays per-person).
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
    via_call: boolean;
  }>(
    `SELECT recipient, body, status, notion_task_id, auto_complete, via_call
     FROM scheduled_messages WHERE id = $1`,
    [scheduledId]
  );
  const row = res.rows[0];
  if (!row) return;

  // ATOMICALLY claim this send before doing anything. If another attempt (a
  // pg-boss retry, or a duplicate job) already claimed it, we get 0 rows and
  // bail — a message can never be delivered twice.
  if (row.status === "armed") {
    const claim = await query(
      `UPDATE scheduled_messages SET status = 'sent', last_fired_at = now()
       WHERE id = $1 AND status = 'armed'`,
      [scheduledId]
    );
    if (claim.rowCount === 0) {
      logger.info("skip scheduled (already claimed)", { scheduledId });
      return;
    }
  } else if (row.status === "recurring") {
    // Recurring repeats, so we can't mark it sent — instead debounce: ignore a
    // second fire within 60s of the last one.
    const claim = await query(
      `UPDATE scheduled_messages SET last_fired_at = now()
       WHERE id = $1 AND (last_fired_at IS NULL OR last_fired_at < now() - interval '60 seconds')`,
      [scheduledId]
    );
    if (claim.rowCount === 0) {
      logger.info("skip scheduled (recurring debounce)", { scheduledId });
      return;
    }
  } else {
    logger.info("skip scheduled", { scheduledId, status: row.status });
    return;
  }

  // Urgent / "call me" / alarm reminders ring the phone. We still send the
  // WhatsApp text so there's a written record (and a fallback if the call fails).
  if (row.via_call && callingEnabled()) {
    try {
      const call = await placeCall(row.recipient, row.body);
      if (!call.ok) logger.warn("call failed, message still sent", { scheduledId, err: call.error });
    } catch (err) {
      logger.warn("call threw, message still sent", { scheduledId, err: String(err) });
    }
  }
  await sendText(row.recipient, row.body);

  // A pure reminder is complete once delivered — close its task so it doesn't
  // linger as overdue. (Family/vaccination nudges have auto_complete = false.)
  if (row.status === "armed" && row.auto_complete && row.notion_task_id) {
    await markTaskDone(row.notion_task_id).catch(() => {});
  }
  logger.info("scheduled message sent", { scheduledId, to: row.recipient, recurring: row.status === "recurring" });
}
