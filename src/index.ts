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
    return { ok: true, db, tz: config.TIMEZONE };
  });

  // Phase 2+: registerWebhookRoutes(app)
  // Phase 7:  registerGoogleOAuthRoutes(app)
  const { registerWebhookRoutes } = await import("./whatsapp/routes.js");
  await registerWebhookRoutes(app);

  const { registerGoogleOAuthRoutes } = await import("./google/routes.js");
  await registerGoogleOAuthRoutes(app);

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
