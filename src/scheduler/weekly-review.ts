import Anthropic from "@anthropic-ai/sdk";
import { DateTime } from "luxon";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { query } from "../db/pool.js";
import { getUser, type AuthorKey } from "../users.js";
import { createWeeklyReviewPage } from "../notion/log.js";
import { listEvents } from "../google/calendar.js";
import { isConnected } from "../google/auth.js";
import { getMealPlans } from "../meals.js";
import { sendProactive } from "../whatsapp/proactive.js";

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

/**
 * Sunday-night review — PERSONAL to each partner, but including the household
 * things they share.
 *
 * Each person gets: their own week (their notes, their reminders, their calendar),
 * the shared/common picture (meal plan, family, shopping), and what's coming up
 * for them. Both partners get one, even if they captured nothing that week — the
 * shared section is still useful to them.
 */
export async function runWeeklyReview(authorKey: AuthorKey): Promise<void> {
  const user = getUser(authorKey);
  const now = DateTime.now().setZone(config.TIMEZONE);
  const weekAgo = now.minus({ days: 7 });
  const weekAhead = now.plus({ days: 7 });
  const week = `${weekAgo.toFormat("dd LLL")}–${now.toFormat("dd LLL")}`;

  // ---- PERSONAL: their own notes this week
  const caps = await query<{ category: string; transcript: string; language_code: string }>(
    `SELECT category, transcript, language_code FROM captures
     WHERE author_key = $1 AND created_at >= now() - interval '7 days'
     ORDER BY created_at ASC`,
    [authorKey]
  );

  // ---- PERSONAL: their reminders this week (what they asked to be nudged about)
  const rems = await query<{ body: string; send_at: string; status: string }>(
    `SELECT body, send_at, status FROM scheduled_messages
     WHERE author_key = $1 AND kind = 'reminder'
       AND (created_at >= now() - interval '7 days' OR send_at >= now())
     ORDER BY send_at ASC LIMIT 20`,
    [authorKey]
  );

  // ---- PERSONAL: their calendar — past week and the week ahead
  let pastEvents: { summary: string; start?: string }[] = [];
  let upcomingEvents: { summary: string; start?: string }[] = [];
  if (await isConnected(authorKey).catch(() => false)) {
    pastEvents = await listEvents(authorKey, weekAgo.toISO()!, now.toISO()!, 20).catch(() => []);
    upcomingEvents = await listEvents(authorKey, now.toISO()!, weekAhead.toISO()!, 20).catch(() => []);
  }

  // ---- SHARED: the household picture both partners care about
  const meals = await getMealPlans(now.toISODate()!, weekAhead.toISODate()!).catch(() => []);
  const sharedCaps = await query<{ author_name: string; category: string; transcript: string }>(
    `SELECT author_name, category, transcript FROM captures
     WHERE created_at >= now() - interval '7 days'
       AND category IN ('Family','Shopping','Meals')
     ORDER BY created_at ASC LIMIT 30`
  );

  const list = (arr: string[]) => (arr.length ? arr.join("\n") : "(nothing)");
  const personalNotes = list(caps.rows.map((r) => `- [${r.category}] ${r.transcript.slice(0, 220)}`));
  const reminders = list(
    rems.rows.map((r) => `- ${r.body.slice(0, 120)} (${r.send_at.slice(0, 10)}, ${r.status})`)
  );
  const past = list(pastEvents.map((e) => `- ${e.summary}${e.start ? ` (${e.start.slice(0, 10)})` : ""}`));
  const upcoming = list(upcomingEvents.map((e) => `- ${e.summary}${e.start ? ` (${e.start.slice(0, 10)})` : ""}`));
  const mealPlan = list(
    meals.map((m) => `- ${m.planDate}: ${m.breakfast ?? "?"} / ${m.lunch ?? "?"}${m.status === "confirmed" ? " ✅" : ""}`)
  );
  const shared = list(
    sharedCaps.rows.map((r) => `- [${r.category}] (${r.author_name}) ${r.transcript.slice(0, 160)}`)
  );

  const hindiShare =
    caps.rows.length > 0
      ? caps.rows.filter((r) => (r.language_code ?? "").startsWith("hi")).length / caps.rows.length
      : 0;
  const langInstruction =
    hindiShare > 0.4
      ? "Write in friendly Hinglish (Roman Hindi mixed with English)."
      : "Write in warm, simple English.";

  const msg = await anthropic.messages.create({
    model: config.CLAUDE_REVIEW_MODEL,
    max_tokens: 900,
    system: `You are Home-Agent writing ${user.name}'s PERSONAL weekly review. Address ${user.name} directly as "you".
${langInstruction} Be specific, warm and kind — never corporate. Under ~220 words.

Structure:
1) *Your week* — their own notes, the reminders they set, what was on their calendar.
2) *At home* — the shared household picture: the meal plan, family/baby things, shopping. This is the
   part they share with their partner, so keep it brief and useful.
3) *Coming up* — their own upcoming calendar events and pending reminders.
4) 2-3 gentle suggestions for next week.

CRITICAL: Use ONLY the facts listed below — never invent events, meetings or tasks. Skip any section
that has nothing in it rather than padding it. If their personal week was quiet, say so kindly and
lean on the shared section.`,
    messages: [
      {
        role: "user",
        content: `Weekly review for ${user.name}, week of ${week}.

=== ${user.name}'s own notes this week ===
${personalNotes}

=== ${user.name}'s reminders ===
${reminders}

=== ${user.name}'s calendar, past week ===
${past}

=== ${user.name}'s calendar, week ahead ===
${upcoming}

=== SHARED: meal plan for the coming days ===
${mealPlan}

=== SHARED: household notes this week (family / shopping / meals, from both partners) ===
${shared}`,
      },
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
  }).catch((err) => logger.warn("weekly review notion failed", { err: String(err) }));

  await sendProactive(user, `🗓️ *Your week (${week})*\n\n${summary}`);
  logger.info("weekly review delivered", { authorKey, notes: caps.rows.length });
}
