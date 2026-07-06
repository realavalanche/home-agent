import type { FastifyInstance } from "fastify";
import { consentUrl, handleCallback } from "./auth.js";
import type { AuthorKey } from "../users.js";

/**
 * OAuth endpoints. `/oauth/google/start?user=A` kicks off consent (used by the
 * CLI helper and printable links); Google redirects back to the callback with
 * the code + the author key in `state`.
 */
export async function registerGoogleOAuthRoutes(app: FastifyInstance) {
  app.get("/oauth/google/start", async (req, reply) => {
    const user = (req.query as Record<string, string>).user as AuthorKey;
    if (user !== "A" && user !== "B") return reply.code(400).send("pass ?user=A or ?user=B");
    return reply.redirect(consentUrl(user));
  });

  app.get("/oauth/google/callback", async (req, reply) => {
    const q = req.query as Record<string, string>;
    const code = q.code;
    const state = q.state as AuthorKey;
    if (!code || (state !== "A" && state !== "B")) {
      return reply.code(400).send("missing code/state");
    }
    try {
      await handleCallback(code, state);
      return reply.type("text/html").send(
        `<html><body style="font-family:sans-serif"><h2>✓ Connected Google for user ${state}</h2>
         <p>You can close this tab.</p></body></html>`
      );
    } catch (err) {
      return reply.code(500).send(`OAuth failed: ${String(err)}`);
    }
  });
}
