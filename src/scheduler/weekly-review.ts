import Anthropic from "@anthropic-ai/sdk";
import { DateTime } from "luxon";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { query } from "../db/pool.js";
import { allUsers } from "../users.js";
import { createWeeklyReviewPage } from "../notion/log.js";
import { sendProactive } from "../whatsapp/proactive.js";

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

interface WeekRow {
  author_name: string;
  category: string;
  transcript: string;
  language_code: string;
}

/**
 * Sunday-night HOUSEHOLD review, delivered to BOTH partners.
 *
 * It covers the whole household's week (each person's highlights, plus what they
 * share — meals, family, shopping), so both of them see the same picture. Sending
 * it only to whoever happened to capture notes meant the quieter partner never
 * heard anything, which defeats the point of a shared assistant.
 */
export async function runWeeklyReview(): Promise<void> {
  const res = await query<WeekRow>(
    `SELECT author_name, category, transcript, language_code
     FROM captures
     WHERE created_at >= now() - interval '7 days'
     ORDER BY created_at ASC`
  );
  const rows = res.rows;
  if (!rows.length) {
    logger.info("weekly review: no captures for the household");
    return;
  }

  const hindiShare = rows.filter((r) => (r.language_code ?? "").startsWith("hi")).length / rows.length;
  const langInstruction =
    hindiShare > 0.4
      ? "Write in friendly Hinglish (Roman Hindi mixed with English)."
      : "Write in warm, simple English.";

  // Group the week's notes by person so the summary can speak to each of them.
  const names = allUsers().map((u) => u.name);
  const notes = names
    .map((name) => {
      const theirs = rows.filter((r) => r.author_name === name);
      const body = theirs.length
        ? theirs.map((r) => `  - [${r.category}] ${r.transcript.slice(0, 250)}`).join("\n")
        : "  (nothing captured this week)";
      return `${name}:\n${body}`;
    })
    .join("\n\n");

  const now = DateTime.now().setZone(config.TIMEZONE);
  const week = `${now.minus({ days: 7 }).toFormat("dd LLL")}–${now.toFormat("dd LLL")}`;

  const msg = await anthropic.messages.create({
    model: config.CLAUDE_REVIEW_MODEL,
    max_tokens: 900,
    system: `You are Home-Agent writing the weekly review for a household of two: ${names.join(" and ")}.
This SAME message goes to BOTH of them, so address them together and speak about each by name.
${langInstruction} Be specific, warm and kind — never corporate.

Structure:
1) Highlights of the household's week (mention each person's notable bits by name)
2) Anything shared worth noting (meals, family/baby, shopping, plans they're both part of)
3) 2-3 gentle suggestions for next week

Only use what's given below. Do not invent events. If one person captured nothing, don't scold them —
just focus on what actually happened. Keep it under ~220 words.`,
    messages: [
      { role: "user", content: `The household's notes for ${week}:\n\n${notes}` },
    ],
  });

  const summary = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  // One Notion record per person so it shows in each of their views.
  for (const user of allUsers()) {
    await createWeeklyReviewPage({
      title: `Weekly Review · ${week}`,
      authorName: user.name,
      markdown: summary,
    }).catch((err) => logger.warn("weekly review notion failed", { err: String(err) }));
  }

  // Deliver to BOTH partners.
  for (const user of allUsers()) {
    await sendProactive(user, `🗓️ *Our week (${week})*\n\n${summary}`);
  }
  logger.info("weekly review delivered to household", { count: rows.length });
}
