import { config } from "../config.js";
import { logger } from "../logger.js";
import { sendText, sendTemplate, isWindowOpen } from "./client.js";
import type { User } from "../users.js";

/**
 * Send a business-INITIATED message (morning briefing, meal check-in, reminder).
 *
 * WhatsApp only allows free-form text within 24 hours of the user's last message.
 * If that window has closed, we can't send our text at all — so instead we send an
 * approved template ("just checking in") which IS allowed any time. The moment the
 * user replies, the window reopens and everything flows normally again.
 */
export async function sendProactive(user: User, body: string): Promise<void> {
  if (await isWindowOpen(user.key)) {
    await sendText(user.whatsapp, body);
    return;
  }

  logger.info("24h window closed — sending check-in template instead", { user: user.key });
  const ok = await sendTemplate(
    user.whatsapp,
    config.WHATSAPP_CHECKIN_TEMPLATE,
    config.WHATSAPP_TEMPLATE_LANG,
    [user.name]
  );
  if (!ok) {
    // Template not approved yet / misconfigured — try the text anyway so we at
    // least surface the real error in the logs rather than staying silent.
    await sendText(user.whatsapp, body);
  }
}
