import { config } from "../config.js";
import { logger } from "../logger.js";
import { query } from "../db/pool.js";
import { allUsers, type User } from "../users.js";
import { sendTemplate } from "../whatsapp/client.js";
import { expireStaleConfirmations } from "./schedule.js";

/**
 * Keep WhatsApp's 24-hour window open.
 *
 * WhatsApp only lets us send free-form messages within 24h of the user's last
 * message. If that lapses, briefings / reminders / check-ins simply can't reach
 * them. So BEFORE the window closes (default: 23h of silence) we send a warm
 * "are you doing ok?" template — templates ARE allowed any time — giving them a
 * chance to reply and reset the clock. Reacting only once the window has already
 * shut is too late: that day's message is already lost.
 *
 * Anti-spam: we ping at most once per period of silence. If they still don't
 * reply, we gently re-ping only every few days rather than going silent forever.
 */
const REPING_AFTER_DAYS = 3;

/** Hours since this user last messaged us; undefined if they never have. */
async function hoursSinceLastMessage(authorKey: string): Promise<number | undefined> {
  const res = await query<{ last: string | null }>(
    `SELECT max(created_at) AS last FROM conversation_turns
     WHERE author_key = $1 AND role = 'user'`,
    [authorKey]
  );
  const last = res.rows[0]?.last;
  if (!last) return undefined;
  return (Date.now() - new Date(last).getTime()) / (1000 * 60 * 60);
}

/**
 * Send the check-in ping — but only if we haven't already pinged since they last
 * spoke to us (or it's been long enough to gently try again). Self-deduplicating,
 * so it's safe to call from anywhere.
 */
export async function pingOnce(user: User): Promise<boolean> {
  const res = await query<{ last_msg: string | null; last_ping: string | null }>(
    `SELECT
       (SELECT max(created_at) FROM conversation_turns
          WHERE author_key = $1 AND role = 'user') AS last_msg,
       (SELECT last_ping_at FROM keepalive_pings WHERE author_key = $1) AS last_ping`,
    [user.key]
  );
  const row = res.rows[0];
  const lastMsg = row?.last_msg ? new Date(row.last_msg).getTime() : 0;
  const lastPing = row?.last_ping ? new Date(row.last_ping).getTime() : 0;

  const pingedSinceTheySpoke = lastPing > lastMsg;
  const pingIsStale = Date.now() - lastPing > REPING_AFTER_DAYS * 24 * 60 * 60 * 1000;

  if (pingedSinceTheySpoke && !pingIsStale) {
    logger.info("keepalive: already pinged this silence period", { user: user.key });
    return false;
  }

  const ok = await sendTemplate(
    user.whatsapp,
    config.WHATSAPP_CHECKIN_TEMPLATE,
    config.WHATSAPP_TEMPLATE_LANG,
    [user.name]
  );
  if (ok) {
    await query(
      `INSERT INTO keepalive_pings (author_key, last_ping_at) VALUES ($1, now())
       ON CONFLICT (author_key) DO UPDATE SET last_ping_at = now()`,
      [user.key]
    );
    logger.info("keepalive ping sent", { user: user.key, hoursQuiet: Math.round((Date.now() - lastMsg) / 3600000) });
  }
  return ok;
}

/**
 * Hourly: ping anyone quiet long enough that their window is about to close,
 * giving them time to reply BEFORE it does.
 */
export async function runKeepalive(): Promise<void> {
  // Also expire stale "please confirm?" offers so an old one can never be
  // triggered later and send an out-of-context message.
  const expired = await expireStaleConfirmations().catch(() => 0);
  if (expired) logger.info("expired stale confirmations", { count: expired });

  for (const user of allUsers()) {
    const hours = await hoursSinceLastMessage(user.key);
    if (hours === undefined) continue; // never messaged us — nothing to keep alive
    if (hours < config.WINDOW_KEEPALIVE_HOURS) continue;
    await pingOnce(user);
  }
}
