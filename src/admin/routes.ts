import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { AuthorKey } from "../users.js";

/**
 * Manually trigger a scheduled job — useful for testing (and for backfilling a
 * review someone missed) instead of waiting for its cron. Protected by the same
 * secret as the webhook verify token, so it isn't publicly runnable.
 *
 *   POST /admin/run?job=weekly&user=B&token=…
 *   jobs: weekly | morning | meal | notion-sync
 */
export async function registerAdminRoutes(app: FastifyInstance) {
  /** Inspect recent voice calls — did we actually place one, and what happened? */
  app.get("/admin/calls", async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (q.token !== config.WHATSAPP_VERIFY_TOKEN) {
      return reply.code(401).send({ ok: false, error: "unauthorized" });
    }
    const { query } = await import("../db/pool.js");
    const res = await query(
      `SELECT execution_id, author_key, purpose, context, recipient, status, processed, created_at
       FROM calls ORDER BY created_at DESC LIMIT 15`
    );
    return { ok: true, count: res.rowCount, calls: res.rows };
  });

  app.post("/admin/run", async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (q.token !== config.WHATSAPP_VERIFY_TOKEN) {
      return reply.code(401).send({ ok: false, error: "unauthorized" });
    }

    const job = q.job;
    const user = q.user as AuthorKey | undefined;
    logger.info("admin trigger", { job, user });

    try {
      switch (job) {
        case "weekly": {
          if (user !== "A" && user !== "B") {
            return reply.code(400).send({ ok: false, error: "pass user=A or user=B" });
          }
          const { runWeeklyReview } = await import("../scheduler/weekly-review.js");
          await runWeeklyReview(user);
          return { ok: true, ran: "weekly-review", user };
        }
        case "morning": {
          if (user !== "A" && user !== "B") {
            return reply.code(400).send({ ok: false, error: "pass user=A or user=B" });
          }
          const { runMorningBriefing } = await import("../scheduler/morning-briefing.js");
          await runMorningBriefing(user);
          return { ok: true, ran: "morning-briefing", user };
        }
        case "meal": {
          const { runMealCheckin } = await import("../scheduler/meal-checkin.js");
          await runMealCheckin();
          return { ok: true, ran: "meal-checkin" };
        }
        case "notion-sync": {
          const { runNotionSync } = await import("../scheduler/notion-sync.js");
          await runNotionSync();
          return { ok: true, ran: "notion-sync" };
        }
        default:
          return reply
            .code(400)
            .send({ ok: false, error: "unknown job", jobs: ["weekly", "morning", "meal", "notion-sync"] });
      }
    } catch (err) {
      logger.error("admin trigger failed", { job, user, err: String(err) });
      return reply.code(500).send({ ok: false, error: String(err) });
    }
  });
}
