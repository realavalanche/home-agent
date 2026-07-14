import { query } from "../db/pool.js";
import { getBoss, QUEUES, type SendJob } from "../queue.js";
import type { AuthorKey } from "../users.js";
import { createTaskPage, updateTaskDue, markTaskDone } from "../notion/log.js";

/**
 * Create + arm scheduled WhatsApp messages. Kinds:
 *  - reminder: sent back to the user themselves. Also mirrored as a Notion Task
 *    (with a Due date) so pending reminders are visible and snoozable.
 *  - recurring reminder: repeats on a cron until stopped.
 *  - outbound: sent to a third party → parked as `awaiting_confirm` first.
 *
 * The row in scheduled_messages is the source of truth; pg-boss triggers dispatch
 * (a delayed job for one-time, a keyed cron for recurring).
 */

async function insertRow(
  authorKey: AuthorKey,
  recipient: string,
  body: string,
  sendAtISO: string,
  kind: "reminder" | "outbound",
  status: "armed" | "awaiting_confirm" | "recurring",
  extra: {
    notionTaskId?: string;
    recurrence?: string;
    scheduleKey?: string;
    autoComplete?: boolean;
    viaCall?: boolean;
    escalate?: boolean;
  } = {}
): Promise<number> {
  const res = await query<{ id: number }>(
    `INSERT INTO scheduled_messages
       (author_key, recipient, body, send_at, kind, status, notion_task_id, recurrence, schedule_key, auto_complete, via_call, escalate)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [
      authorKey,
      recipient,
      body,
      sendAtISO,
      kind,
      status,
      extra.notionTaskId ?? null,
      extra.recurrence ?? null,
      extra.scheduleKey ?? null,
      extra.autoComplete ?? false,
      extra.viaCall ?? false,
      extra.escalate ?? false,
    ]
  );
  return res.rows[0]!.id;
}

async function armJob(scheduledId: number, sendAtISO: string): Promise<void> {
  const boss = await getBoss();
  const jobId = await boss.sendAfter(
    QUEUES.SEND,
    { scheduledId } satisfies SendJob,
    {},
    new Date(sendAtISO)
  );
  await query(`UPDATE scheduled_messages SET job_id = $2, status = 'armed' WHERE id = $1`, [
    scheduledId,
    jobId,
  ]);
}

/**
 * One-time reminder to the user. Creates a linked Notion Task (Due = when) and
 * arms the WhatsApp nudge. Returns the row id.
 */
export async function scheduleReminder(
  authorKey: AuthorKey,
  authorName: string,
  recipient: string,
  body: string,
  sendAtISO: string,
  viaCall = false,
  escalate = false
): Promise<number> {
  let notionTaskId: string | undefined;
  try {
    notionTaskId = await createTaskPage({ title: body, authorName, due: sendAtISO });
  } catch {
    /* Notion is best-effort; the nudge still fires even if the task fails. */
  }
  const id = await insertRow(authorKey, recipient, body, sendAtISO, "reminder", "armed", {
    notionTaskId,
    autoComplete: true, // a pure reminder's job is done once it fires
    viaCall,
    escalate,
  });
  await armJob(id, sendAtISO);
  return id;
}

/**
 * A one-time WhatsApp nudge linked to an ALREADY-created Notion task (used by
 * the family tracker, which makes its own Family tasks). No new task is created,
 * and the task is NOT auto-completed — being reminded about a vaccine doesn't
 * mean it was given.
 */
export async function scheduleNudge(
  authorKey: AuthorKey,
  recipient: string,
  body: string,
  sendAtISO: string,
  notionTaskId?: string
): Promise<number> {
  const id = await insertRow(authorKey, recipient, body, sendAtISO, "reminder", "armed", {
    notionTaskId,
    autoComplete: false,
  });
  await armJob(id, sendAtISO);
  return id;
}

/**
 * Recurring reminder driven by a pg-boss cron. `cron` is a 5-field expression in
 * app-timezone (built by the tool from a simple frequency). Repeats until stopped.
 */
export async function scheduleRecurringReminder(
  authorKey: AuthorKey,
  authorName: string,
  recipient: string,
  body: string,
  cron: string,
  timezone: string,
  nextRunISO: string
): Promise<number> {
  let notionTaskId: string | undefined;
  try {
    notionTaskId = await createTaskPage({ title: `🔁 ${body}`, authorName, due: nextRunISO });
  } catch {
    /* best-effort */
  }
  const scheduleKey = `rem-${authorKey}-${Date.now()}`;
  const id = await insertRow(authorKey, recipient, body, nextRunISO, "reminder", "recurring", {
    notionTaskId,
    recurrence: cron,
    scheduleKey,
  });
  const boss = await getBoss();
  await boss.schedule(QUEUES.SEND, cron, { scheduledId: id } satisfies SendJob, {
    tz: timezone,
    key: scheduleKey,
  });
  return id;
}

interface ReminderRow {
  id: number;
  recipient: string;
  body: string;
  send_at: string;
  job_id: string | null;
  notion_task_id: string | null;
  schedule_key: string | null;
  status: string;
}

/** Find the reminder a snooze/stop refers to: best text match, else most recent. */
async function findTargetReminder(
  authorKey: AuthorKey,
  statuses: string[],
  matchText?: string
): Promise<ReminderRow | undefined> {
  const res = await query<ReminderRow>(
    `SELECT id, recipient, body, send_at, job_id, notion_task_id, schedule_key, status
     FROM scheduled_messages
     WHERE author_key = $1 AND kind = 'reminder' AND status = ANY($2)
     ORDER BY (($3 <> '') AND (body ILIKE '%' || $3 || '%')) DESC,
              COALESCE(last_fired_at, created_at) DESC
     LIMIT 1`,
    [authorKey, statuses, matchText ?? ""]
  );
  return res.rows[0];
}

/** Postpone the user's active one-time reminder to a new time. */
export async function snoozeReminder(
  authorKey: AuthorKey,
  newWhenISO: string,
  matchText?: string
): Promise<{ ok: boolean; body?: string }> {
  const row = await findTargetReminder(authorKey, ["armed", "sent"], matchText);
  if (!row) return { ok: false };
  const boss = await getBoss();
  if (row.job_id) await boss.cancel(QUEUES.SEND, row.job_id).catch(() => {});
  await query(`UPDATE scheduled_messages SET send_at = $2, status = 'armed' WHERE id = $1`, [
    row.id,
    newWhenISO,
  ]);
  await armJob(row.id, newWhenISO);
  if (row.notion_task_id) await updateTaskDue(row.notion_task_id, newWhenISO).catch(() => {});
  return { ok: true, body: row.body };
}

/** Stop a recurring reminder (or cancel a pending one-time reminder). */
export async function stopReminder(
  authorKey: AuthorKey,
  matchText?: string
): Promise<{ ok: boolean; body?: string }> {
  const row = await findTargetReminder(authorKey, ["recurring", "armed"], matchText);
  if (!row) return { ok: false };
  const boss = await getBoss();
  if (row.schedule_key) await boss.unschedule(QUEUES.SEND, row.schedule_key).catch(() => {});
  if (row.job_id) await boss.cancel(QUEUES.SEND, row.job_id).catch(() => {});
  await query(`UPDATE scheduled_messages SET status = 'cancelled' WHERE id = $1`, [row.id]);
  if (row.notion_task_id) await markTaskDone(row.notion_task_id).catch(() => {});
  return { ok: true, body: row.body };
}

/** The user's most recent reminder that has a linked Notion task. */
export async function latestReminderWithTask(
  authorKey: AuthorKey
): Promise<ReminderRow | undefined> {
  const res = await query<ReminderRow>(
    `SELECT id, recipient, body, send_at, job_id, notion_task_id, schedule_key, status
     FROM scheduled_messages
     WHERE author_key = $1 AND kind = 'reminder' AND notion_task_id IS NOT NULL
       AND status IN ('armed','sent','recurring')
     ORDER BY COALESCE(last_fired_at, created_at) DESC LIMIT 1`,
    [authorKey]
  );
  return res.rows[0];
}

/** Finalize a reminder row as done: cancel any pending/recurring jobs, set status. */
export async function completeReminderRow(row: ReminderRow): Promise<void> {
  const boss = await getBoss();
  if (row.schedule_key) await boss.unschedule(QUEUES.SEND, row.schedule_key).catch(() => {});
  if (row.job_id) await boss.cancel(QUEUES.SEND, row.job_id).catch(() => {});
  await query(`UPDATE scheduled_messages SET status = 'done' WHERE id = $1`, [row.id]);
}

/** Complete the reminder row (if any) linked to a given Notion task id. */
export async function completeReminderByTaskId(
  authorKey: AuthorKey,
  taskId: string
): Promise<void> {
  const res = await query<ReminderRow>(
    `SELECT id, recipient, body, send_at, job_id, notion_task_id, schedule_key, status
     FROM scheduled_messages WHERE author_key = $1 AND notion_task_id = $2`,
    [authorKey, taskId]
  );
  const row = res.rows[0];
  if (row) await completeReminderRow(row);
}

/** List the user's active reminders (armed one-time + recurring). */
export async function listReminders(
  authorKey: AuthorKey
): Promise<{ body: string; send_at: string; recurring: boolean }[]> {
  const res = await query<{ body: string; send_at: string; recurrence: string | null }>(
    `SELECT body, send_at, recurrence FROM scheduled_messages
     WHERE author_key = $1 AND kind = 'reminder' AND status IN ('armed','recurring')
     ORDER BY send_at ASC`,
    [authorKey]
  );
  return res.rows.map((r) => ({ body: r.body, send_at: r.send_at, recurring: !!r.recurrence }));
}

/** Outbound to a third party. Parked pending the user's confirmation. */
export async function scheduleOutboundPending(
  authorKey: AuthorKey,
  recipient: string,
  body: string,
  sendAtISO: string
): Promise<number> {
  return insertRow(authorKey, recipient, body, sendAtISO, "outbound", "awaiting_confirm");
}

/** The user's most recent unconfirmed outbound message, if any. */
export async function latestPendingConfirmation(
  authorKey: AuthorKey
): Promise<{ id: number; recipient: string; body: string; send_at: string } | undefined> {
  const res = await query<{ id: number; recipient: string; body: string; send_at: string }>(
    `SELECT id, recipient, body, send_at FROM scheduled_messages
     WHERE author_key = $1 AND status = 'awaiting_confirm'
     ORDER BY created_at DESC LIMIT 1`,
    [authorKey]
  );
  return res.rows[0];
}

/** Confirm + arm a parked outbound message. */
export async function confirmScheduled(id: number): Promise<boolean> {
  const res = await query<{ send_at: string }>(
    `SELECT send_at FROM scheduled_messages WHERE id = $1 AND status = 'awaiting_confirm'`,
    [id]
  );
  const row = res.rows[0];
  if (!row) return false;
  await armJob(id, new Date(row.send_at).toISOString());
  return true;
}

export async function cancelScheduled(id: number): Promise<void> {
  await query(`UPDATE scheduled_messages SET status = 'cancelled' WHERE id = $1`, [id]);
}
