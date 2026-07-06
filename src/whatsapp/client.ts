import { config } from "../config.js";
import { logger } from "../logger.js";

const GRAPH = `https://graph.facebook.com/${config.WHATSAPP_GRAPH_VERSION}`;

function authHeaders() {
  return {
    Authorization: `Bearer ${config.WHATSAPP_ACCESS_TOKEN}`,
    "Content-Type": "application/json",
  };
}

/**
 * Send a plain text WhatsApp message from the business number.
 * `to` is E.164 digits (no '+'). Returns the sent message id.
 */
export async function sendText(to: string, body: string): Promise<string | undefined> {
  const res = await fetch(`${GRAPH}/${config.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { preview_url: false, body: truncate(body) },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    logger.error("whatsapp send failed", { status: res.status, body: text, to });
    return undefined;
  }
  const json = (await res.json()) as { messages?: { id: string }[] };
  return json.messages?.[0]?.id;
}

/** Mark an inbound message as read (the blue ticks) so the user sees we got it. */
export async function markRead(messageId: string): Promise<void> {
  try {
    await fetch(`${GRAPH}/${config.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
      }),
    });
  } catch (err) {
    logger.warn("mark read failed", { err: String(err), messageId });
  }
}

// WhatsApp text messages cap at 4096 chars.
function truncate(body: string): string {
  return body.length > 4096 ? body.slice(0, 4093) + "…" : body;
}
