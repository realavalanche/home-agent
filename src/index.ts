import Fastify from "fastify";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { pool } from "./db/pool.js";

/**
 * Single entrypoint: HTTP server (webhook + OAuth callbacks + health) plus the
 * pg-boss worker/scheduler, all in one process so a single small machine runs
 * everything. Routes and the scheduler are registered by their own modules as
 * they are built out across phases.
 */
const PRIVACY_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Home-Agent — Privacy Policy</title>
<style>body{font-family:system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;line-height:1.6;color:#222}h1{font-size:1.6rem}h2{font-size:1.1rem;margin-top:1.6em}small{color:#666}</style>
</head><body>
<h1>Home-Agent — Privacy Policy</h1>
<p><small>Last updated: 2026. Contact: sid.317@gmail.com</small></p>
<p>Home-Agent is a private personal assistant used by a single household (two authorized users)
over WhatsApp. It is not a public service and does not onboard other users.</p>
<h2>What we process</h2>
<p>When an authorized user messages the assistant, we process the message text and, for voice notes,
a text transcript of the audio. <strong>Raw audio is never stored</strong> — it is transcribed and
immediately discarded. Messages from unrecognized numbers are rejected and not stored.</p>
<h2>How it is used</h2>
<p>Message text is used solely to provide the assistant's features for the two users: categorizing and
saving notes, semantic search over past notes, creating calendar events and reminders, and scheduling
messages. Data is stored in the users' own Notion workspace and a private database, and is processed by
AI providers (Anthropic, Sarvam, Voyage) only to deliver these features.</p>
<h2>Sharing</h2>
<p>We do not sell or share personal data with third parties for advertising. Data is shared with the
service providers above only as needed to operate the assistant.</p>
<h2>Retention & deletion</h2>
<p>Notes persist until deleted by the users. To delete data or ask questions, contact
<a href="mailto:sid.317@gmail.com">sid.317@gmail.com</a>.</p>
</body></html>`;

export async function buildServer() {
  const app = Fastify({
    logger: false,
    // We need the raw body to verify Meta's HMAC signature. Fastify's default
    // JSON parser discards it, so webhook routes register a raw-body parser.
    bodyLimit: 5 * 1024 * 1024,
  });

  app.get("/health", async () => {
    let db = "down";
    try {
      await pool.query("select 1");
      db = "up";
    } catch {
      db = "down";
    }
    // ffmpeg is required to split voice notes over Sarvam's 30s limit.
    const { spawnSync } = await import("node:child_process");
    const ffmpeg = spawnSync("ffmpeg", ["-version"]).status === 0 ? "up" : "missing";
    return { ok: true, db, ffmpeg, tz: config.TIMEZONE };
  });

  // Privacy policy — Meta requires a valid Privacy Policy URL to take the app
  // Live. Served from the app itself so there's no external host to maintain.
  app.get("/privacy", async (_req, reply) => {
    reply.type("text/html").send(PRIVACY_HTML);
  });

  // Phase 2+: registerWebhookRoutes(app)
  // Phase 7:  registerGoogleOAuthRoutes(app)
  const { registerWebhookRoutes } = await import("./whatsapp/routes.js");
  await registerWebhookRoutes(app);

  const { registerGoogleOAuthRoutes } = await import("./google/routes.js");
  await registerGoogleOAuthRoutes(app);

  const { registerAdminRoutes } = await import("./admin/routes.js");
  await registerAdminRoutes(app);

  return app;
}

async function main() {
  const app = await buildServer();

  // Boot the background worker + scheduled jobs (pg-boss).
  const { startScheduler } = await import("./scheduler/jobs.js");
  await startScheduler();

  await app.listen({ port: config.PORT, host: "0.0.0.0" });
  logger.info("home-agent up", { port: config.PORT, tz: config.TIMEZONE });
}

// Only run when invoked directly (not when imported by tests/scripts).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    logger.error("fatal boot error", { err: String(err) });
    process.exit(1);
  });
}
