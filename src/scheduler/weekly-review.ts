import Anthropic from "@anthropic-ai/sdk";
import { DateTime } from "luxon";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { query } from "../db/pool.js";
import { getUser, type AuthorKey } from "../users.js";
import { createWeeklyReviewPage } from "../notion/log.js";
import { sendText } from "../whatsapp/client.js";

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

interface WeekRow {
  category: string;
  transcript: string;
  language_code: string;
  created_at: string;
}

/**
 * Build and deliver the Sunday-night review for one user: pull the last 7 days
 * of their captures, have Claude summarize highlights/patterns/suggestions in
 * the language they mostly used, then post to Notion + WhatsApp.
 */
export async function runWeeklyReview(authorKey: AuthorKey): Promise<void> {
  const user = getUser(authorKey);
  const res = await query<WeekRow>(
    `SELECT category, transcript, language_code, created_at
     FROM captures
     WHERE author_key = $1 AND created_at >= now() - interval '7 days'
     ORDER BY created_at ASC`,
    [authorKey]
  );
  const rows = res.rows;
  if (!rows.length) {
    logger.info("weekly review: no captures", { authorKey });
    return;
  }

  const hindiShare = rows.filter((r) => (r.language_code ?? "").startsWith("hi")).length / rows.length;
  const langInstruction =
    hindiShare > 0.4
      ? "Write in friendly Hinglish (Roman Hindi mixed with English)."
      : "Write in warm, simple English.";

  const notes = rows
    .map((r) => `- [${r.category}] ${r.transcript.slice(0, 300)}`)
    .join("\n");

  const week = `${DateTime.now().setZone(config.TIMEZONE).minus({ days: 7 }).toFormat("dd LLL")}–${DateTime.now().setZone(config.TIMEZONE).toFormat("dd LLL")}`;

  const msg = await anthropic.messages.create({
    model: config.CLAUDE_REVIEW_MODEL,
    max_tokens: 900,
    system: `You are Home-Agent writing ${user.name}'s weekly review. ${langInstruction}
Be specific and kind. Structure: 1) Highlights of the week, 2) Patterns you noticed,
3) 2-3 gentle suggestions for next week. Keep it under ~200 words. No preamble.`,
    messages: [
      { role: "user", content: `Here are ${user.name}'s notes for ${week}:\n\n${notes}` },
    ],
  });

  const summary = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  await createWeeklyReviewPage({
    title: `Weekly Review · ${user.name} · ${week}`,
    authorName: user.name,
    markdown: summary,
  });

  await sendText(user.whatsapp, `🗓️ *Your week (${week})*\n\n${summary}`);
  logger.info("weekly review delivered", { authorKey, count: rows.length });
}
