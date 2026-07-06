import crypto from "node:crypto";
import { config } from "../config.js";

/**
 * Verify Meta's X-Hub-Signature-256 header against the raw request body using
 * HMAC-SHA256 keyed with the app secret. MUST run on the exact raw bytes Meta
 * signed — not a re-serialized JSON object — so the webhook route captures the
 * raw body via a custom content-type parser.
 */
export function verifySignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
  if (!signatureHeader) return false;
  const expected =
    "sha256=" +
    crypto.createHmac("sha256", config.WHATSAPP_APP_SECRET).update(rawBody).digest("hex");
  // Constant-time compare; guard against length mismatch which timingSafeEqual throws on.
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
