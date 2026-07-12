import { z } from "zod";
import "dotenv/config";

/**
 * Central env loading + validation. Import `config` anywhere; it throws at boot
 * if a required var is missing so we fail fast rather than mid-request.
 *
 * Some vars are only needed by specific subsystems (Notion ids get written by
 * the setup script, Google ids are optional until OAuth is done). Those are
 * marked optional here and validated at their point of use.
 */

// Node ships dotenv-less; we rely on `import "dotenv/config"` above being a
// no-op if the package is absent (tsx/node 20+ can also use --env-file). To
// keep zero-config, we don't hard-depend on dotenv — see loadEnv() fallback.

const schema = z.object({
  PORT: z.coerce.number().default(8080),
  PUBLIC_BASE_URL: z.string().url(),
  TIMEZONE: z.string().default("Asia/Kolkata"),

  DATABASE_URL: z.string().min(1),

  WHATSAPP_PHONE_NUMBER_ID: z.string().min(1),
  WHATSAPP_ACCESS_TOKEN: z.string().min(1),
  WHATSAPP_APP_SECRET: z.string().min(1),
  WHATSAPP_VERIFY_TOKEN: z.string().min(1),
  WHATSAPP_BUSINESS_ACCOUNT_ID: z.string().optional(),
  WHATSAPP_GRAPH_VERSION: z.string().default("v21.0"),
  // Approved template used to re-engage when the 24h free-form window has closed.
  WHATSAPP_CHECKIN_TEMPLATE: z.string().default("checkin_ping"),
  WHATSAPP_TEMPLATE_LANG: z.string().default("en"),

  USER_A_NAME: z.string().default("User A"),
  USER_A_WHATSAPP: z.string().min(6),
  USER_A_GOOGLE_EMAIL: z.string().optional(),

  USER_B_NAME: z.string().default("User B"),
  USER_B_WHATSAPP: z.string().min(6),
  USER_B_GOOGLE_EMAIL: z.string().optional(),

  NOTION_TOKEN: z.string().min(1),
  NOTION_PARENT_PAGE_ID: z.string().optional(),
  NOTION_DB_CAPTURES: z.string().optional(),
  NOTION_DB_TASKS: z.string().optional(),
  NOTION_DB_WEEKLY: z.string().optional(),
  NOTION_DS_CAPTURES: z.string().optional(),
  NOTION_DS_TASKS: z.string().optional(),
  NOTION_DS_WEEKLY: z.string().optional(),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().optional(),

  ANTHROPIC_API_KEY: z.string().min(1),
  SARVAM_API_KEY: z.string().min(1),
  VOYAGE_API_KEY: z.string().min(1),

  // Bolna voice calls (optional). Without these, "call me" reminders fall back
  // to a WhatsApp message.
  BOLNA_API_KEY: z.string().optional(),
  BOLNA_AGENT_ID: z.string().optional(),
  BOLNA_FROM_NUMBER: z.string().optional(),

  CLAUDE_AGENT_MODEL: z.string().default("claude-sonnet-5"),
  CLAUDE_REVIEW_MODEL: z.string().default("claude-opus-4-8"),
  VOYAGE_MODEL: z.string().default("voyage-3"),
  SARVAM_STT_MODEL: z.string().default("saarika:v2.5"),
});

export type Config = z.infer<typeof schema>;

export const config: Config = schema.parse(process.env);

/** Normalize a phone to digits only (E.164 without '+') for reliable matching. */
export function normalizePhone(raw: string): string {
  return raw.replace(/[^0-9]/g, "");
}
