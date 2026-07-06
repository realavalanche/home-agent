import { query } from "../db/pool.js";
import { getBoss, QUEUES, type SendJob } from "../queue.js";
import type { AuthorKey } from "../users.js";

/**
 * Create + arm scheduled WhatsApp messages. Two kinds:
 *  - reminder: sent back to the requesting user themselves → armed immediately.
 *  - outbound: sent to a third party → parked as `awaiting_confirm` until the
 *    user confirms, so a mis-transcribed name/number can't message a stranger.
 *
 * The row in scheduled_messages is the source of truth; pg-boss just triggers
 * dispatch at send_at via a delayed job that references the row id.
 */

async function insertRow(
  authorKey: AuthorKey,
  recipient: string,
  body: string,
  sendAtISO: string,
  kind: "reminder" | "outbound",
  status: "armed" | "awaiting_confirm"
): Promise<number> {
  const res = await query<{ id: number }>(
    `INSERT INTO scheduled_messages (author_key, recipient, body, send_at, kind, status)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [authorKey, recipient, body, sendAtISO, kind, status]
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

/** Reminder to the user themselves. Armed right away. */
export async function scheduleReminder(
  authorKey: AuthorKey,
  recipient: string,
  body: string,
  sendAtISO: string
): Promise<number> {
  const id = await insertRow(authorKey, recipient, body, sendAtISO, "reminder", "armed");
  await armJob(id, sendAtISO);
  return id;
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
