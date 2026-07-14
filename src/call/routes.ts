import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { query } from "../db/pool.js";
import { getUser, type AuthorKey } from "../users.js";
import { sendText } from "../whatsapp/client.js";
import { enqueueIngest } from "../queue.js";

/**
 * Post-call webhook from Bolna. Bolna POSTs the execution data as the call moves
 * through queued → in-progress → completed. Once completed, we have the transcript
 * — which is what lets the assistant ACT on what was said:
 *
 *   capture  → the user's hands-free brain dump: feed it through the agent so it
 *              gets categorized and filed to Notion, exactly like a voice note.
 *   outbound → we called someone on their behalf: summarize the outcome back to them.
 *   reminder → one-way announcement; nothing to act on.
 *
 * Bolna can't send custom auth headers, so the endpoint is protected by a secret
 * in the query string.
 */
interface BolnaWebhookBody {
  id?: string;
  execution_id?: string;
  status?: string;
  transcript?: string;
  error_message?: string | null;
  telephony_data?: { duration?: string | number; to_number?: string; recording_url?: string };
}

export async function registerCallRoutes(app: FastifyInstance) {
  app.post("/webhook/bolna", async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (q.token !== config.WHATSAPP_VERIFY_TOKEN) {
      return reply.code(401).send({ ok: false, error: "unauthorized" });
    }

    const body = req.body as BolnaWebhookBody;
    const executionId = body.execution_id ?? body.id;
    const status = body.status ?? "unknown";
    if (!executionId) return reply.code(400).send({ ok: false, error: "no execution id" });

    // Ack immediately; Bolna shouldn't wait on our processing.
    reply.code(200).send({ ok: true });

    const res = await query<{
      author_key: string;
      purpose: string;
      context: string | null;
      processed: boolean;
    }>(
      `UPDATE calls SET status = $2, transcript = COALESCE($3, transcript)
       WHERE execution_id = $1
       RETURNING author_key, purpose, context, processed`,
      [executionId, status, body.transcript ?? null]
    );
    const call = res.rows[0];
    if (!call) {
      logger.warn("bolna webhook for unknown call", { executionId, status });
      return;
    }

    logger.info("bolna webhook", { executionId, status, purpose: call.purpose });

    // Only act once the call is finished and we actually have something said.
    if (status !== "completed" || call.processed) return;
    const transcript = (body.transcript ?? "").trim();
    if (!transcript) {
      logger.info("bolna call completed with no transcript", { executionId, purpose: call.purpose });
      return;
    }

    await query(`UPDATE calls SET processed = true WHERE execution_id = $1`, [executionId]);
    const authorKey = call.author_key as AuthorKey;
    const user = getUser(authorKey);

    try {
      if (call.purpose === "capture") {
        // Route the brain dump through the normal agent pipeline so it's
        // categorized, filed to Notion, and any actions in it are carried out.
        await enqueueIngest({
          waMessageId: `call.${executionId}`, // synthetic id keeps ingest idempotent
          fromPhone: user.whatsapp,
          type: "text",
          text: `[Voice call — I said this out loud, please capture and act on it]\n\n${transcript}`,
          timestamp: Date.now(),
        });
        logger.info("capture call queued for processing", { executionId });
      } else if (call.purpose === "outbound") {
        await summarizeOutboundCall(user.whatsapp, call.context ?? "", transcript);
      }
    } catch (err) {
      logger.error("bolna webhook processing failed", { executionId, err: String(err) });
      await sendText(user.whatsapp, "I made the call, but something went wrong handling the result. 🙏");
    }
  });
}

/** Tell the user how the call we made on their behalf went. */
async function summarizeOutboundCall(
  toWhatsapp: string,
  task: string,
  transcript: string
): Promise<void> {
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  const msg = await anthropic.messages.create({
    model: config.CLAUDE_AGENT_MODEL,
    max_tokens: 400,
    system:
      "You are reporting back on a phone call an assistant made on the user's behalf. " +
      "In 2-4 short lines: what was the outcome, and any concrete details (times, prices, names, next steps). " +
      "If the task was NOT achieved, say so plainly. No preamble.",
    messages: [
      { role: "user", content: `Task: ${task}\n\nCall transcript:\n${transcript}` },
    ],
  });
  const summary = msg.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("\n")
    .trim();
  await sendText(toWhatsapp, `📞 *Call done* — ${task}\n\n${summary}`);
}
