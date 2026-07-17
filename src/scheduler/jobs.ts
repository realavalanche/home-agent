import type { Job } from "pg-boss";
import { logger } from "../logger.js";
import { config } from "../config.js";
import { getBoss, QUEUES, type IngestJob, type SendJob, type WeeklyJob } from "../queue.js";
import { query } from "../db/pool.js";
import { processIngest } from "../ingest.js";
import { sendText } from "../whatsapp/client.js";
import { markTaskDone } from "../notion/log.js";
import { placeCall, callingEnabled, INSTRUCTIONS, GREETINGS } from "../call.js";
import type { AuthorKey } from "../users.js";
import { runWeeklyReview } from "./weekly-review.js";
import { runMorningBriefing } from "./morning-briefing.js";
import { runNotionSync } from "./notion-sync.js";
import { runMealCheckin } from "./meal-checkin.js";
import { runKeepalive } from "./keepalive.js";
import { allUsers, getUser } from "../users.js";

/** How long an URGENT reminder may sit unread before we ring the phone. */
const ESCALATE_AFTER_MINUTES = 30;

/** Body used to mark a scheduled row as a hands-free capture call, not a reminder. */
export const CAPTURE_CALL_MARKER = "__capture_call__";

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

  // 3) Weekly review — PERSONAL to each partner (their own week + the shared
  //    household picture). One job per user.
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

  // 6) Meal check-in for tomorrow, daily at 15:00 IST (skips if already settled).
  await boss.work(QUEUES.MEAL_CHECKIN, async () => {
    await runMealCheckin();
  });
  await boss.schedule(QUEUES.MEAL_CHECKIN, "0 15 * * *", {}, { tz: config.TIMEZONE, key: "meal-checkin" });

  // 7) Hourly keep-alive: ping before WhatsApp's 24h window closes, so the
  //    briefings/reminders never get silently blocked.
  await boss.work(QUEUES.KEEPALIVE, async () => {
    await runKeepalive();
  });
  await boss.schedule(QUEUES.KEEPALIVE, "0 * * * *", {}, { tz: config.TIMEZONE, key: "keepalive" });

  // 8) Escalation: an URGENT reminder still unread after 30 min → ring the phone.
  await boss.work<SendJob>(QUEUES.ESCALATE, async (jobs: Job<SendJob>[]) => {
    for (const job of jobs) await escalateIfUnread(job.data.scheduledId);
  });

  // Remove the short-lived household schedule; the review is per-person again.
  await boss.unschedule(QUEUES.WEEKLY, "weekly-household").catch(() => {});

  // Who receives the 6:30am morning briefing (the rest are opted out).
  const morningUsers = new Set(
    config.MORNING_BRIEFING_USERS.split(",").map((s) => s.trim()).filter(Boolean)
  );

  // pg-boss cron is UTC unless tz is given; we pin it to the app timezone.
  for (const user of allUsers()) {
    // Sunday 21:00 IST → each partner's own weekly review.
    await boss.schedule(
      QUEUES.WEEKLY,
      "0 21 * * 0",
      { authorKey: user.key } satisfies WeeklyJob,
      { tz: config.TIMEZONE, key: `weekly-${user.key}` }
    );
    // Daily good-morning briefing at 06:30 IST — only for opted-in users.
    if (morningUsers.has(user.key)) {
      await boss.schedule(
        QUEUES.MORNING,
        "30 6 * * *",
        { authorKey: user.key } satisfies WeeklyJob,
        { tz: config.TIMEZONE, key: `morning-${user.key}` }
      );
    } else {
      // Remove any previously-registered schedule for an opted-out user.
      await boss.unschedule(QUEUES.MORNING, `morning-${user.key}`).catch(() => {});
    }
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
    author_key: string;
    recipient: string;
    body: string;
    status: string;
    notion_task_id: string | null;
    auto_complete: boolean;
    via_call: boolean;
    escalate: boolean;
  }>(
    `SELECT author_key, recipient, body, status, notion_task_id, auto_complete, via_call, escalate
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

  // A scheduled hands-free CAPTURE call: ring them and let them think out loud.
  // No WhatsApp text — the whole point is the call; the transcript comes back via
  // the Bolna webhook and gets filed.
  if (row.body === CAPTURE_CALL_MARKER) {
    if (callingEnabled()) {
      const user = getUser(row.author_key as AuthorKey);
      await placeCall({
        toPhoneDigits: row.recipient,
        purpose: "capture",
        instruction: INSTRUCTIONS.capture(user.name),
        greeting: GREETINGS.capture(user.name),
        authorKey: user.key,
        context: "hands-free capture call",
        name: user.name,
      }).catch((err) => logger.error("capture call failed", { scheduledId, err: String(err) }));
    }
    return;
  }

  // Urgent / "call me" / alarm reminders ring the phone. We still send the
  // WhatsApp text so there's a written record (and a fallback if the call fails).
  if (row.via_call && callingEnabled()) {
    try {
      const user = getUser(row.author_key as AuthorKey);
      const call = await placeCall({
        toPhoneDigits: row.recipient,
        purpose: "reminder",
        instruction: INSTRUCTIONS.reminder(row.body),
        greeting: GREETINGS.reminder(user.name, row.body),
        authorKey: user.key,
        context: row.body,
        name: user.name,
      });
      if (!call.ok) logger.warn("call failed, message still sent", { scheduledId, err: call.error });
    } catch (err) {
      logger.warn("call threw, message still sent", { scheduledId, err: String(err) });
    }
  }

  const waId = await sendText(row.recipient, row.body);

  // URGENT reminders escalate: if it's still unread in 30 minutes, we ring them.
  if (row.escalate && waId && callingEnabled()) {
    await query(`UPDATE scheduled_messages SET sent_wa_id = $2 WHERE id = $1`, [scheduledId, waId]);
    const boss = await getBoss();
    await boss.sendAfter(
      QUEUES.ESCALATE,
      { scheduledId } satisfies SendJob,
      {},
      new Date(Date.now() + ESCALATE_AFTER_MINUTES * 60 * 1000)
    );
    logger.info("escalation armed", { scheduledId, minutes: ESCALATE_AFTER_MINUTES });
  }

  // A pure reminder is complete once delivered — close its task so it doesn't
  // linger as overdue. (Family/vaccination nudges have auto_complete = false.)
  if (row.status === "armed" && row.auto_complete && row.notion_task_id) {
    await markTaskDone(row.notion_task_id).catch(() => {});
  }
  logger.info("scheduled message sent", { scheduledId, to: row.recipient, recurring: row.status === "recurring" });
}

/**
 * An urgent reminder was sent 30 minutes ago. If WhatsApp says the user still
 * hasn't READ it, ring their phone — a call is much harder to miss.
 * (If their read receipts are off we'll only ever see "delivered"; in that case
 * we escalate anyway, since we can't prove they saw it.)
 */
async function escalateIfUnread(scheduledId: number): Promise<void> {
  const res = await query<{
    author_key: string;
    recipient: string;
    body: string;
    sent_wa_id: string | null;
    wa_status: string | null;
  }>(
    `SELECT s.author_key, s.recipient, s.body, s.sent_wa_id, o.status AS wa_status
     FROM scheduled_messages s
     LEFT JOIN outbound_messages o ON o.wa_message_id = s.sent_wa_id
     WHERE s.id = $1`,
    [scheduledId]
  );
  const row = res.rows[0];
  if (!row) return;

  if (row.wa_status === "read") {
    logger.info("escalation skipped — reminder was read", { scheduledId });
    return;
  }

  logger.info("escalating unread urgent reminder to a call", { scheduledId, waStatus: row.wa_status });
  if (!callingEnabled()) {
    logger.warn("escalation wanted but calling not configured", { scheduledId });
    return;
  }
  const escUser = getUser(row.author_key as AuthorKey);
  await placeCall({
    toPhoneDigits: row.recipient,
    purpose: "reminder",
    instruction: INSTRUCTIONS.reminder(row.body),
    greeting: GREETINGS.reminder(escUser.name, row.body),
    authorKey: escUser.key,
    context: row.body,
    name: escUser.name,
  }).catch((err) => logger.error("escalation call failed", { scheduledId, err: String(err) }));
}
