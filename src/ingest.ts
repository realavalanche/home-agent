import { logger } from "./logger.js";
import { query } from "./db/pool.js";
import type { IngestJob } from "./queue.js";
import { identifyUser } from "./users.js";
import { downloadMedia } from "./whatsapp/media.js";
import { transcribe } from "./transcribe/sarvam.js";
import { describeMedia } from "./vision.js";
import { sendText, markRead } from "./whatsapp/client.js";
import { runAgent } from "./agent/run.js";
import type { AgentContext } from "./agent/tools.js";

// If the agent is slower than this, we send a quick ack first (requirement:
// reply within ~15s, ack immediately if slower).
const ACK_AFTER_MS = 3000;

/**
 * Process one inbound WhatsApp message end to end:
 * identify sender → (transcribe if voice) → run agent → reply in same language.
 * Unknown senders get a polite rejection and nothing is stored.
 */
export async function processIngest(job: IngestJob): Promise<void> {
  const user = identifyUser(job.fromPhone);
  if (!user) {
    await sendText(
      job.fromPhone,
      "Hi! This is a private family assistant and I don't recognise this number, so I can't help here. 🙏"
    );
    return;
  }

  await markRead(job.waMessageId).catch(() => {});

  // Resolve the message to text (transcribe voice; describe images/PDFs; never
  // persist the raw media).
  let transcript: string;
  let language = "en-IN";
  let source: "voice" | "text" | "image";
  if (job.type === "audio" && job.mediaId) {
    source = "voice";
    // MUST be guarded: if download/transcription throws and we don't catch it, the
    // job dies and the user gets total silence — no ack, no error, nothing.
    try {
      const media = await downloadMedia(job.mediaId);
      const t = await transcribe(media);
      transcript = t.text;
      language = t.languageCode;
    } catch (err) {
      logger.error("voice transcription failed", { err: String(err), waMessageId: job.waMessageId });
      await sendText(
        user.whatsapp,
        "Sorry — I couldn't process that voice note. 🙏 Could you try sending it again? (If it's a long one, breaking it into a couple of shorter notes helps.)"
      );
      return;
    }
    if (!transcript) {
      await sendText(user.whatsapp, "Sorry, I couldn't make out that voice note — could you resend it?");
      return;
    }
  } else if ((job.type === "image" || job.type === "document") && job.mediaId) {
    source = "image";
    try {
      const media = await downloadMedia(job.mediaId);
      const described = await describeMedia(media, job.caption);
      if (!described) {
        await sendText(user.whatsapp, "I can read images and PDFs, but not that file type yet.");
        return;
      }
      // Include the caption so the agent has the user's intent alongside the extraction.
      transcript = job.caption ? `${job.caption}\n\n[Attachment] ${described}` : `[Attachment] ${described}`;
      language = looksHindi(job.caption ?? "") ? "hi-IN" : "en-IN";
    } catch (err) {
      logger.error("attachment processing failed", { err: String(err), waMessageId: job.waMessageId });
      await sendText(user.whatsapp, "Sorry — I couldn't read that attachment. 🙏 Mind sending it again?");
      return;
    }
  } else {
    source = "text";
    transcript = job.text ?? "";
    language = looksHindi(transcript) ? "hi-IN" : "en-IN";
  }

  // If the user REPLIED to a message, resolve what they quoted so "remind me
  // about this" has something to point at.
  if (job.quotedId) {
    const quoted = await resolveQuoted(job.quotedId);
    if (quoted) {
      transcript = `[Replying to this earlier message: "${quoted}"]\n\n${transcript}`;
    }
  }

  const ctx: AgentContext = {
    user,
    waMessageId: job.waMessageId,
    transcript,
    language,
    source,
  };

  // Ack if the agent is taking a while, so the user isn't left hanging.
  let acked = false;
  const ackTimer = setTimeout(() => {
    acked = true;
    void sendText(user.whatsapp, language.startsWith("hi") ? "Mil gaya, dekh raha hoon… ⏳" : "Got it, on it… ⏳");
  }, ACK_AFTER_MS);

  try {
    const reply = await runAgent(ctx);
    clearTimeout(ackTimer);
    await sendText(user.whatsapp, reply);
  } catch (err) {
    clearTimeout(ackTimer);
    logger.error("agent run failed", { err: String(err), waMessageId: job.waMessageId });
    await sendText(
      user.whatsapp,
      language.startsWith("hi") ? "Arre, kuch gadbad ho gayi. Thodi der baad try karein? 🙏" : "Something went wrong on my end — mind trying again? 🙏"
    );
  }
  void acked; // (ack is best-effort; final reply always follows)
}

/**
 * Resolve the text of a message the user replied to. It may be one WE sent
 * (a reply, reminder, or briefing) or one THEY sent earlier (a logged capture).
 */
async function resolveQuoted(quotedId: string): Promise<string | undefined> {
  const ours = await query<{ body: string }>(
    `SELECT body FROM outbound_messages WHERE wa_message_id = $1`,
    [quotedId]
  ).catch(() => ({ rows: [] as { body: string }[] }));
  if (ours.rows[0]) return ours.rows[0].body;

  const theirs = await query<{ transcript: string }>(
    `SELECT transcript FROM captures WHERE wa_message_id = $1`,
    [quotedId]
  ).catch(() => ({ rows: [] as { transcript: string }[] }));
  return theirs.rows[0]?.transcript;
}

/** Cheap heuristic: Devanagari or common Roman-Hindi tokens → treat as Hindi. */
function looksHindi(text: string): boolean {
  if (/[ऀ-ॿ]/.test(text)) return true;
  return /\b(hai|nahi|kya|karo|kal|mujhe|chahiye|karna|bhej|yaad)\b/i.test(text);
}
