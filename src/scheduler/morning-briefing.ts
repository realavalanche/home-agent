import Anthropic from "@anthropic-ai/sdk";
import { DateTime } from "luxon";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { query } from "../db/pool.js";
import { getUser, type AuthorKey } from "../users.js";
import { listOverdueTasks } from "../notion/log.js";
import { listEvents } from "../google/calendar.js";
import { isConnected } from "../google/auth.js";
import { sendText } from "../whatsapp/client.js";

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

/**
 * A warm 6:30am briefing per user: reflects on yesterday (what they captured /
 * did), flags anything overdue, and sets a gentle tone for the day. Not a dry
 * calendar dump — a friendly good-morning that helps them start the day.
 */
export async function runMorningBriefing(authorKey: AuthorKey): Promise<void> {
  const user = getUser(authorKey);
  const now = DateTime.now().setZone(config.TIMEZONE);
  const todayISODate = now.toISODate()!;

  // Yesterday's captures for this user (day boundaries in app timezone).
  const startOfToday = now.startOf("day");
  const startOfYesterday = startOfToday.minus({ days: 1 });
  const caps = await query<{ category: string; transcript: string; language_code: string }>(
    `SELECT category, transcript, language_code FROM captures
     WHERE author_key = $1 AND created_at >= $2 AND created_at < $3
     ORDER BY created_at ASC`,
    [authorKey, startOfYesterday.toISO(), startOfToday.toISO()]
  ).catch(() => ({ rows: [] as { category: string; transcript: string; language_code: string }[] }));

  // Overdue tasks, but only those slipped in the last few days — old, un-cleared
  // items shouldn't pile up in the daily nudge.
  const overdueAll = await listOverdueTasks(user.name, todayISODate).catch(() => []);
  const cutoff = startOfToday.minus({ days: 4 }).toISODate()!;
  const overdue = overdueAll.filter((o) => o.due && o.due.slice(0, 10) >= cutoff).slice(0, 5);

  // Today's REAL calendar events (so "today" is grounded, never invented).
  let todayEvents: { summary: string; start?: string }[] = [];
  if (await isConnected(authorKey).catch(() => false)) {
    todayEvents = await listEvents(
      authorKey,
      startOfToday.toISO()!,
      startOfToday.endOf("day").toISO()!
    ).catch(() => []);
  }

  const yesterdayNotes = caps.rows.map((r) => `- [${r.category}] ${r.transcript.slice(0, 200)}`).join("\n");
  const overdueList = overdue.map((o) => `- ${o.title} (was due ${o.due.slice(0, 10)})`).join("\n");
  const todayList = todayEvents.map((e) => `- ${e.summary}${e.start ? ` at ${e.start.slice(11, 16)}` : ""}`).join("\n");
  const hindiShare =
    caps.rows.length > 0
      ? caps.rows.filter((r) => (r.language_code ?? "").startsWith("hi")).length / caps.rows.length
      : 0;
  const lang = hindiShare > 0.4 ? "Reply in friendly Hinglish." : "Reply in warm, simple English.";

  const msg = await anthropic.messages.create({
    model: config.CLAUDE_REVIEW_MODEL,
    max_tokens: 500,
    system: `You are Home-Agent sending ${user.name} a short, warm good-morning briefing at 6:30am.
${lang} Be genuinely kind and human, not corporate. Under ~120 words.

CRITICAL: Use ONLY the facts provided below. Do NOT invent, infer, or add any events, meetings,
tasks, or plans that aren't explicitly listed. Items under "Yesterday" are in the PAST — reflect on
them warmly; NEVER present them as upcoming or as "today". Only the items under "Today's calendar"
are today's actual events — if that list is empty, do not mention any plans for today.

Structure: a warm greeting; a one-line reflection on yesterday (only if there's something); a gentle
nudge on overdue items (only if present); today's real calendar events (only if listed); a short
encouraging close. If everything is empty, just send a brief cheerful good morning.`,
    messages: [
      {
        role: "user",
        content: `Date: ${now.toFormat("cccc, dd LLL")}.

Yesterday ${user.name} captured (PAST — for reflection only):
${yesterdayNotes || "(nothing)"}

Overdue tasks (gentle nudge, only if listed):
${overdueList || "(none)"}

Today's calendar (the ONLY real events for today):
${todayList || "(nothing scheduled)"}`,
      },
    ],
  });

  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  await sendText(user.whatsapp, `☀️ ${text}`);
  logger.info("morning briefing sent", { authorKey, overdue: overdue.length });
}
