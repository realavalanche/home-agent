import { config } from "./config.js";
import { logger } from "./logger.js";
import { query } from "./db/pool.js";
import type { AuthorKey } from "./users.js";

/**
 * Voice calls via Bolna.
 *
 * ONE Bolna agent serves every purpose: we pass an `instruction` in `user_data`
 * telling it what to do on this call, so the agent's prompt only needs to follow
 * {instruction}. Purposes:
 *   - reminder: speak the reminder, hang up (one-way).
 *   - capture:  ask what's on their mind, LISTEN, let them talk (hands-free brain dump).
 *   - outbound: call a third party and carry out a task on the user's behalf.
 *
 * Every call is recorded so the post-call webhook knows why it happened and can
 * act on the transcript.
 */
export type CallPurpose = "reminder" | "capture" | "outbound" | "partner";

export function callingEnabled(): boolean {
  return Boolean(config.BOLNA_API_KEY && config.BOLNA_AGENT_ID);
}

export interface PlaceCallInput {
  toPhoneDigits: string;
  purpose: CallPurpose;
  instruction: string; // what the voice agent should actually do on the call
  greeting: string; // the exact opening line (differs per purpose AND per person)
  authorKey: AuthorKey;
  context?: string; // the reminder text / the task, for the webhook to reference
  name?: string;
}

export async function placeCall(
  input: PlaceCallInput
): Promise<{ ok: boolean; executionId?: string; error?: string }> {
  if (!callingEnabled()) return { ok: false, error: "calling_not_configured" };

  const to = `+${input.toPhoneDigits.replace(/[^0-9]/g, "")}`; // E.164
  const body: Record<string, unknown> = {
    agent_id: config.BOLNA_AGENT_ID,
    recipient_phone_number: to,
    user_data: {
      name: input.name ?? "",
      greeting: input.greeting,
      instruction: input.instruction,
      purpose: input.purpose,
    },
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
    logger.error("bolna call failed", { status: res.status, body: text, to, purpose: input.purpose });
    return { ok: false, error: `${res.status} ${text}` };
  }

  // Bolna returns the execution id; we key the post-call webhook off it.
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const executionId =
    (json.execution_id as string) ?? (json.id as string) ?? (json.call_id as string) ?? undefined;

  if (executionId) {
    await query(
      `INSERT INTO calls (execution_id, author_key, purpose, context, recipient, status)
       VALUES ($1,$2,$3,$4,$5,'queued')
       ON CONFLICT (execution_id) DO NOTHING`,
      [executionId, input.authorKey, input.purpose, input.context ?? null, to]
    ).catch((err) => logger.warn("call record failed", { err: String(err) }));
  } else {
    logger.warn("bolna gave no execution id — webhook cannot be matched", { purpose: input.purpose });
  }

  logger.info("bolna call placed", { to, purpose: input.purpose, executionId });
  return { ok: true, executionId };
}

/**
 * The opening line for each kind of call. This MUST vary by purpose: on an
 * outbound call we're greeting a stranger (the electrician), NOT the household
 * member — so we can't just say "Hi <user>".
 */
export const GREETINGS = {
  // Bolna speaks the greeting, then WAITS for the person to talk before the LLM
  // says anything. So an announcement call must deliver its whole message in the
  // greeting — otherwise the line just goes silent until it times out.
  reminder: (name: string, text: string) =>
    `Hi ${name}, it's your assistant with a reminder. ${text}`,

  partner: (toName: string, fromName: string, message: string) =>
    `Hi ${toName}! It's the home assistant. ${fromName} asked me to tell you: ${message}`,

  // Capture genuinely wants them to talk next, so a question is right here.
  capture: (name: string) =>
    `Hi ${name}, it's your assistant. Whenever you're ready — what's on your mind?`,

  // The agent writes a natural opening line for third-party calls.
  outbound: (onBehalfOf: string, openingLine: string) =>
    `Hello! I'm calling on behalf of ${onBehalfOf}. ${openingLine}`,
} as const;

/**
 * What the agent does AFTER the greeting (which already delivered the message).
 * Keep these about handling the reply, not about re-stating the message.
 */
export const INSTRUCTIONS = {
  reminder: (text: string) =>
    `You have just delivered this reminder in your greeting: "${text}". ` +
    `If they acknowledge, confirm warmly and END the call. If they ask you to repeat it, repeat it once. ` +
    `Do not chat. Keep the whole call under 30 seconds.`,

  partner: (toName: string, fromName: string, message: string) =>
    `You have just told ${toName} this message from ${fromName}: "${message}". ` +
    `This is family, not a business call — be warm and natural. If she replies in Hindi or Hinglish, ` +
    `reply in the same language. Confirm she's understood, briefly answer any question about the message, ` +
    `then thank her and END the call. Keep it under a minute.`,

  capture: (name: string) =>
    `You are calling ${name} so they can think out loud hands-free (they may be driving). ` +
    `You have already asked what's on their mind. Now LISTEN. Let them talk freely without interrupting. ` +
    `If they pause, gently ask "anything else?". Do not give advice — you are only here to capture. ` +
    `When they say they're done, confirm you've got it, tell them you'll save it, and END the call.`,

  outbound: (onBehalfOf: string, task: string) =>
    `You are a polite assistant calling on behalf of ${onBehalfOf}. Your task: ${task}. ` +
    `You have already introduced yourself and opened the conversation. Be courteous and concise. ` +
    `Get a clear answer or confirmation, repeat back the key details to be sure, then thank them and END ` +
    `the call. Do not make commitments beyond the task.`,
} as const;
