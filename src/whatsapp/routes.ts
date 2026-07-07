import type { FastifyInstance, FastifyRequest } from "fastify";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { verifySignature } from "./verify.js";
import { enqueueIngest, type IngestJob } from "../queue.js";

/**
 * Meta webhook shape (only the fields we use). A POST can carry multiple
 * entries/changes; each `messages[]` item is one inbound message. Meta also
 * sends status callbacks (delivered/read) with no `messages` — we ignore those.
 */
interface WebhookBody {
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: Array<{
          id: string;
          from: string;
          timestamp: string;
          type: string;
          text?: { body: string };
          audio?: { id: string };
          image?: { id: string; caption?: string };
          document?: { id: string; caption?: string; filename?: string };
        }>;
      };
    }>;
  }>;
}

// Stash the raw body bytes on the request so the signature check runs on the
// exact payload Meta signed.
declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export async function registerWebhookRoutes(app: FastifyInstance) {
  // Capture raw bytes AND parse JSON for application/json requests.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (req: FastifyRequest, body: Buffer, done) => {
      req.rawBody = body;
      try {
        done(null, body.length ? JSON.parse(body.toString("utf8")) : {});
      } catch (err) {
        done(err as Error, undefined);
      }
    }
  );

  // GET: one-time verification handshake when you register the webhook in Meta.
  app.get("/webhook", async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (q["hub.mode"] === "subscribe" && q["hub.verify_token"] === config.WHATSAPP_VERIFY_TOKEN) {
      return reply.code(200).send(q["hub.challenge"]);
    }
    return reply.code(403).send("forbidden");
  });

  // POST: inbound messages. Verify signature, ack 200 fast, enqueue work.
  app.post("/webhook", async (req, reply) => {
    const sig = req.headers["x-hub-signature-256"] as string | undefined;
    if (!req.rawBody || !verifySignature(req.rawBody, sig)) {
      logger.warn("webhook signature rejected");
      return reply.code(401).send("invalid signature");
    }

    // Ack immediately so Meta doesn't retry; process asynchronously.
    reply.code(200).send("ok");

    const body = req.body as WebhookBody;
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        for (const msg of change.value?.messages ?? []) {
          const base = {
            waMessageId: msg.id,
            fromPhone: msg.from,
            timestamp: Number(msg.timestamp) * 1000 || Date.now(),
          };
          let job: IngestJob | undefined;
          if (msg.type === "text" && msg.text) {
            job = { ...base, type: "text", text: msg.text.body };
          } else if (msg.type === "audio" && msg.audio) {
            job = { ...base, type: "audio", mediaId: msg.audio.id };
          } else if (msg.type === "image" && msg.image) {
            job = { ...base, type: "image", mediaId: msg.image.id, caption: msg.image.caption };
          } else if (msg.type === "document" && msg.document) {
            job = { ...base, type: "document", mediaId: msg.document.id, caption: msg.document.caption };
          } else {
            // Unsupported type (image/sticker/etc.) — enqueue as a text note so
            // the agent can reply politely; keeps the pipeline uniform.
            job = { ...base, type: "text", text: `[unsupported ${msg.type} message]` };
          }
          try {
            await enqueueIngest(job);
          } catch (err) {
            logger.error("enqueue failed", { err: String(err), id: msg.id });
          }
        }
      }
    }
  });
}
