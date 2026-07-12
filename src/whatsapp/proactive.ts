import { logger } from "../logger.js";
import { sendText, isWindowOpen } from "./client.js";
import { pingOnce } from "../scheduler/keepalive.js";
import type { User } from "../users.js";

/**
 * Send a business-INITIATED message (morning briefing, meal check-in, reminder).
 *
 * WhatsApp only allows free-form text within 24 hours of the user's last message.
 * The hourly keep-alive normally pings them BEFORE that window closes, so it stays
 * open. If we somehow still find it shut, the message can't be delivered — we log
 * that plainly and fall back to a (de-duplicated) check-in ping.
 */
export async function sendProactive(user: User, body: string): Promise<void> {
  if (await isWindowOpen(user.key)) {
    await sendText(user.whatsapp, body);
    return;
  }

  // Window shut — this message can't be delivered. The hourly keep-alive should
  // normally have pinged them before this happened; call it here as a backstop.
  // pingOnce() de-duplicates, so we never blast repeated templates.
  logger.warn("24h window closed — message not delivered", {
    user: user.key,
    preview: body.slice(0, 60),
  });
  await pingOnce(user);
}
