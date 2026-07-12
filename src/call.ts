import { config } from "./config.js";
import { logger } from "./logger.js";

/**
 * Place an actual phone call via Bolna (voice AI agent) — used only for reminders
 * the user marked urgent, asked to be *called* about, or alarm-style wake-ups.
 * Normal reminders stay as WhatsApp messages.
 *
 * The reminder text is passed as `user_data`, so the Bolna agent's prompt should
 * reference {reminder} (and optionally {name}) to speak it aloud.
 */
export function callingEnabled(): boolean {
  return Boolean(config.BOLNA_API_KEY && config.BOLNA_AGENT_ID);
}

export async function placeCall(
  toPhoneDigits: string,
  reminder: string,
  name?: string
): Promise<{ ok: boolean; error?: string }> {
  if (!callingEnabled()) return { ok: false, error: "calling_not_configured" };

  const body: Record<string, unknown> = {
    agent_id: config.BOLNA_AGENT_ID,
    recipient_phone_number: `+${toPhoneDigits.replace(/[^0-9]/g, "")}`, // E.164
    user_data: { reminder, name: name ?? "" },
  };
  if (config.BOLNA_FROM_NUMBER) body.from_phone_number = config.BOLNA_FROM_NUMBER;

  const res = await fetch("https://api.bolna.ai/call", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.BOLNA_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    logger.error("bolna call failed", { status: res.status, body: text, to: toPhoneDigits });
    return { ok: false, error: `${res.status} ${text}` };
  }
  logger.info("bolna call placed", { to: toPhoneDigits });
  return { ok: true };
}
