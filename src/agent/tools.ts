import type Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { User } from "../users.js";
import { CATEGORIES, MEAL_SUBCATEGORIES, type Category } from "../categorize.js";
import {
  createCapturePage,
  createTaskPage,
  linkRelated,
  findOpenTaskByText,
  markTaskDone,
  archiveCapturePage,
  updateCapturePage,
} from "../notion/log.js";
import {
  storeCapture,
  semanticSearch,
  findRelated,
  findRecentCaptures,
  listCategoryCaptures,
  deleteCaptureRow,
  updateCaptureText,
} from "../search/store.js";
import {
  scheduleReminder,
  scheduleRecurringReminder,
  snoozeReminder,
  stopReminder,
  listReminders,
  scheduleOutboundPending,
  confirmScheduled,
  cancelScheduled,
  latestPendingConfirmation,
  latestReminderWithTask,
  completeReminderRow,
  completeReminderByTaskId,
} from "../scheduler/schedule.js";
import { createEvent, updateEvent, deleteEvent, findEvents, listEvents } from "../google/calendar.js";
import { searchEmail, createDraft } from "../google/gmail.js";
import { isConnected } from "../google/auth.js";
import { normalizePhone } from "../config.js";
import { rememberFact, recallFacts } from "../facts.js";
import { scheduleNudge } from "../scheduler/schedule.js";
import { buildImmunizationSchedule } from "../family.js";
import { query } from "../db/pool.js";
import { DateTime } from "luxon";

export interface AgentContext {
  user: User;
  waMessageId: string;
  transcript: string;
  language: string;
  source: "voice" | "text" | "image";
}

/** Tool schemas advertised to Claude. */
export const TOOLS: Anthropic.Tool[] = [
  {
    name: "log_capture",
    description:
      "File this message into the knowledge base under one category. Auto-links related past notes. For Ideas, pass 1-3 concrete next actions to create linked tasks.",
    input_schema: {
      type: "object",
      properties: {
        category: { type: "string", enum: CATEGORIES as unknown as string[] },
        subcategory: { type: "string", enum: MEAL_SUBCATEGORIES as unknown as string[] },
        title: { type: "string", description: "Short human title, max ~8 words" },
        next_actions: {
          type: "array",
          items: { type: "string" },
          description: "For Ideas only: 1-3 concrete next actions",
        },
      },
      required: ["category", "title"],
    },
  },
  {
    name: "semantic_search",
    description: "Search all past notes (both users) by meaning to answer a question.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "number" } },
      required: ["query"],
    },
  },
  {
    name: "remember",
    description:
      "Permanently store a durable fact for later recall (a contact's phone number, a birthday, an address, an anniversary, a preference). Write it as a clear self-contained sentence.",
    input_schema: {
      type: "object",
      properties: {
        fact: {
          type: "string",
          description: "e.g. \"Arpita's phone number is 9973499229\" or \"Daughter Kuhu's birthday is 3 June 2024\"",
        },
      },
      required: ["fact"],
    },
  },
  {
    name: "recall",
    description:
      "Look up durable facts stored earlier (phone numbers, birthdays, addresses, preferences). Use this BEFORE saying you don't know something, and to resolve a contact's number before messaging them.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "delete_note",
    description:
      "Delete/undo a note you saved. With no match_text, removes the most recent note (an 'undo'). Trashes the Notion page and removes it from search.",
    input_schema: {
      type: "object",
      properties: {
        match_text: { type: "string", description: "Words from the note to delete (optional)" },
      },
    },
  },
  {
    name: "edit_note",
    description: "Edit a saved note's text and/or category. Finds it by text or takes the most recent.",
    input_schema: {
      type: "object",
      properties: {
        match_text: { type: "string" },
        new_text: { type: "string" },
        new_category: { type: "string", enum: CATEGORIES as unknown as string[] },
      },
    },
  },
  {
    name: "show_shopping_list",
    description: "Show the household's running shopping list (recent Shopping items).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "add_family_event",
    description:
      "Log a dated family/baby/health item (doctor visit, school event, vaccination, milestone) as a tracked task with a reminder. Use for one-off family things with a date.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        date_iso: { type: "string", description: "When it's due/happening, ISO 8601 +05:30" },
        remind: { type: "boolean", description: "Also send a WhatsApp reminder (default true)" },
      },
      required: ["title", "date_iso"],
    },
  },
  {
    name: "setup_vaccination_schedule",
    description:
      "Set up a child's full India immunization schedule from their date of birth: creates tracked Family tasks + reminders for each upcoming vaccine. Use when a parent asks to set up vaccinations.",
    input_schema: {
      type: "object",
      properties: {
        child_name: { type: "string" },
        dob_iso: { type: "string", description: "Child's date of birth, yyyy-mm-dd" },
      },
      required: ["child_name", "dob_iso"],
    },
  },
  {
    name: "check_message_status",
    description:
      "Check whether a message the assistant sent was delivered or read (e.g. 'did Arpita read my message?'). Match by recipient number and/or words from the message.",
    input_schema: {
      type: "object",
      properties: {
        recipient: { type: "string", description: "Phone digits, if known" },
        match_text: { type: "string", description: "Words from the message" },
      },
    },
  },
  {
    name: "list_calendar_events",
    description:
      "Read THIS user's upcoming Google Calendar events in a time window (e.g. 'what's on my calendar tomorrow?', 'am I free Friday?').",
    input_schema: {
      type: "object",
      properties: {
        start_iso: { type: "string", description: "Window start, ISO 8601 +05:30 (default: now)" },
        end_iso: { type: "string", description: "Window end, ISO 8601 +05:30 (default: +24h)" },
      },
    },
  },
  {
    name: "schedule_reminder",
    description: "Schedule a WhatsApp reminder back to THIS user at a future time.",
    input_schema: {
      type: "object",
      properties: {
        message: { type: "string" },
        when_iso: { type: "string", description: "ISO 8601 with +05:30 offset" },
      },
      required: ["message", "when_iso"],
    },
  },
  {
    name: "schedule_recurring_reminder",
    description:
      "Set a REPEATING WhatsApp reminder to THIS user (e.g. every day at 9am, every weekday, every Monday). Repeats until the user says stop.",
    input_schema: {
      type: "object",
      properties: {
        message: { type: "string", description: "What to remind them" },
        frequency: { type: "string", enum: ["daily", "weekdays", "weekly"] },
        time_hhmm: { type: "string", description: "24h time in IST, e.g. 09:00 or 21:30" },
        day_of_week: {
          type: "number",
          description: "For weekly only: 0=Sunday … 6=Saturday",
        },
        next_when_iso: {
          type: "string",
          description: "ISO 8601 (+05:30) of the NEXT time it should fire, for display/tracking",
        },
      },
      required: ["message", "frequency", "time_hhmm", "next_when_iso"],
    },
  },
  {
    name: "snooze_reminder",
    description:
      "Postpone/snooze the user's active reminder to a new time (e.g. 'remind me in 2 hours', 'push to tomorrow'). Optionally match which reminder by text.",
    input_schema: {
      type: "object",
      properties: {
        new_when_iso: { type: "string", description: "ISO 8601 with +05:30 offset" },
        match_text: { type: "string", description: "Words from the reminder to disambiguate (optional)" },
      },
      required: ["new_when_iso"],
    },
  },
  {
    name: "stop_reminder",
    description:
      "Stop/cancel a recurring reminder (or a pending one-time reminder). Optionally match which one by text.",
    input_schema: {
      type: "object",
      properties: {
        match_text: { type: "string", description: "Words from the reminder to disambiguate (optional)" },
      },
    },
  },
  {
    name: "list_reminders",
    description: "List this user's active reminders (one-time and recurring).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "mark_done",
    description:
      "Mark a task/reminder as Done in Notion. Use when the user says 'done', 'finished', 'completed X'. With no match_text, completes the most recent reminder.",
    input_schema: {
      type: "object",
      properties: {
        match_text: {
          type: "string",
          description: "Words from the task to complete (optional; omit for the latest reminder)",
        },
      },
    },
  },
  {
    name: "schedule_outbound",
    description:
      "Schedule a WhatsApp message to SOMEONE ELSE. Not sent until the user confirms. Requires the recipient's phone number.",
    input_schema: {
      type: "object",
      properties: {
        recipient_number: { type: "string", description: "Phone in digits, with country code" },
        recipient_name: { type: "string" },
        message: { type: "string" },
        when_iso: { type: "string", description: "ISO 8601 with +05:30 offset" },
      },
      required: ["recipient_number", "message", "when_iso"],
    },
  },
  {
    name: "confirm_pending_send",
    description: "Confirm and arm the user's most recent pending outbound message.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "cancel_pending_send",
    description: "Cancel the user's most recent pending outbound message.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "create_calendar_event",
    description: "Create a Google Calendar event on THIS user's calendar.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        start_iso: { type: "string", description: "ISO 8601 with +05:30 offset" },
        end_iso: { type: "string" },
        description: { type: "string" },
        location: { type: "string" },
        reminder_minutes: { type: "number" },
      },
      required: ["summary", "start_iso"],
    },
  },
  {
    name: "update_calendar_event",
    description: "Find an upcoming event by text and update it.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to find the event" },
        summary: { type: "string" },
        start_iso: { type: "string" },
        end_iso: { type: "string" },
        reminder_minutes: { type: "number" },
      },
      required: ["query"],
    },
  },
  {
    name: "delete_calendar_event",
    description: "Find an upcoming event by text and delete it.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "search_gmail",
    description: "Search THIS user's Gmail. Use Gmail search syntax.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "number" } },
      required: ["query"],
    },
  },
  {
    name: "draft_email",
    description: "Create a Gmail draft (never sent) for the user to review.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string" },
        subject: { type: "string" },
        body: { type: "string" },
      },
      required: ["to", "subject", "body"],
    },
  },
];

type Json = Record<string, unknown>;
const str = (o: Json, k: string) => (typeof o[k] === "string" ? (o[k] as string) : undefined);
const num = (o: Json, k: string) => (typeof o[k] === "number" ? (o[k] as number) : undefined);

function connectHint(user: User): string {
  return `${user.name} hasn't connected Google yet. Ask them to open ${config.PUBLIC_BASE_URL}/oauth/google/start?user=${user.key} once.`;
}

/** Execute a tool call and return a short text result for the model. */
export async function runTool(name: string, input: Json, ctx: AgentContext): Promise<string> {
  try {
    switch (name) {
      case "log_capture":
        return await handleLogCapture(input, ctx);
      case "semantic_search":
        return await handleSearch(input);
      case "remember":
        return await handleRemember(input, ctx);
      case "recall":
        return await handleRecall(input);
      case "delete_note":
        return await handleDeleteNote(input, ctx);
      case "edit_note":
        return await handleEditNote(input, ctx);
      case "show_shopping_list":
        return await handleShoppingList();
      case "add_family_event":
        return await handleFamilyEvent(input, ctx);
      case "setup_vaccination_schedule":
        return await handleVaccinationSchedule(input, ctx);
      case "check_message_status":
        return await handleMessageStatus(input);
      case "list_calendar_events":
        return await handleListEvents(input, ctx);
      case "schedule_reminder":
        return await handleReminder(input, ctx);
      case "schedule_recurring_reminder":
        return await handleRecurringReminder(input, ctx);
      case "snooze_reminder":
        return await handleSnooze(input, ctx);
      case "stop_reminder":
        return await handleStop(input, ctx);
      case "list_reminders":
        return await handleListReminders(ctx);
      case "mark_done":
        return await handleMarkDone(input, ctx);
      case "schedule_outbound":
        return await handleOutbound(input, ctx);
      case "confirm_pending_send":
        return await handleConfirm(ctx);
      case "cancel_pending_send":
        return await handleCancel(ctx);
      case "create_calendar_event":
        return await handleCreateEvent(input, ctx);
      case "update_calendar_event":
        return await handleUpdateEvent(input, ctx);
      case "delete_calendar_event":
        return await handleDeleteEvent(input, ctx);
      case "search_gmail":
        return await handleSearchGmail(input, ctx);
      case "draft_email":
        return await handleDraftEmail(input, ctx);
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    logger.error("tool failed", { name, err: String(err) });
    return `Tool ${name} failed: ${String(err)}`;
  }
}

async function handleLogCapture(input: Json, ctx: AgentContext): Promise<string> {
  const category = (str(input, "category") ?? "Personal") as Category;
  const subRaw = str(input, "subcategory");
  const subcategory = MEAL_SUBCATEGORIES.includes(subRaw as never) ? (subRaw as never) : undefined;
  const title = str(input, "title") ?? ctx.transcript.slice(0, 60);

  const pageId = await createCapturePage({
    title,
    authorKey: ctx.user.key,
    authorName: ctx.user.name,
    category,
    subcategory,
    transcript: ctx.transcript,
    language: ctx.language,
    source: ctx.source,
  });

  const rowId = await storeCapture({
    waMessageId: ctx.waMessageId,
    authorKey: ctx.user.key,
    authorName: ctx.user.name,
    source: ctx.source,
    languageCode: ctx.language,
    transcript: ctx.transcript,
    category,
    subcategory,
    notionPageId: pageId,
  });

  // Auto-link related past notes (requirement 8).
  const related = await findRelated(rowId);
  if (related.length) {
    await linkRelated(
      pageId,
      related.map((r) => r.notionPageId)
    );
  }

  // Ideas → linked tasks (requirement 9).
  const actions = Array.isArray(input.next_actions)
    ? (input.next_actions as unknown[]).filter((a): a is string => typeof a === "string")
    : [];
  let taskNote = "";
  if (category === "Ideas" && actions.length) {
    for (const a of actions.slice(0, 3)) {
      await createTaskPage({ title: a, authorName: ctx.user.name, sourceIdeaPageId: pageId });
    }
    taskNote = ` Created ${Math.min(actions.length, 3)} linked task(s).`;
  }

  const relNote = related.length
    ? ` Linked ${related.length} related note(s): ${related.map((r) => r.transcript.slice(0, 30)).join("; ")}.`
    : "";
  return `Logged under ${category}${subcategory ? "/" + subcategory : ""} as "${title}".${relNote}${taskNote}`;
}

async function handleSearch(input: Json): Promise<string> {
  const q = str(input, "query") ?? "";
  const results = await semanticSearch(q, num(input, "limit") ?? 5);
  if (!results.length) return "No related notes found.";
  return results
    .map(
      (r, i) =>
        `${i + 1}. [${r.category}, ${r.authorName}, ${r.createdAt.slice(0, 10)}] ${r.transcript.slice(0, 160)}`
    )
    .join("\n");
}

async function handleDeleteNote(input: Json, ctx: AgentContext): Promise<string> {
  const [target] = await findRecentCaptures(ctx.user.key, str(input, "match_text") ?? "", 1);
  if (!target) return "I couldn't find a note to delete.";
  await archiveCapturePage(target.notionPageId).catch(() => {});
  await deleteCaptureRow(target.id);
  return `Deleted: "${target.transcript.slice(0, 60)}".`;
}

async function handleEditNote(input: Json, ctx: AgentContext): Promise<string> {
  const [target] = await findRecentCaptures(ctx.user.key, str(input, "match_text") ?? "", 1);
  if (!target) return "I couldn't find a note to edit.";
  const newText = str(input, "new_text");
  const newCategory = str(input, "new_category") as Category | undefined;
  await updateCapturePage(target.notionPageId, {
    transcript: newText,
    category: newCategory,
  });
  if (newText) await updateCaptureText(target.id, newText);
  return `Updated the note${newCategory ? ` (now ${newCategory})` : ""}.`;
}

async function handleFamilyEvent(input: Json, ctx: AgentContext): Promise<string> {
  const title = str(input, "title") ?? "";
  const dateISO = str(input, "date_iso");
  if (!title || !dateISO) return "Need a title and a date.";
  const taskId = await createTaskPage({ title: `👶 ${title}`, authorName: ctx.user.name, due: dateISO });
  const remind = input.remind !== false;
  if (remind) {
    // Nudge the morning of, at 9am (or the given time if earlier in the day).
    const due = DateTime.fromISO(dateISO, { zone: config.TIMEZONE });
    const when = due < DateTime.now().setZone(config.TIMEZONE) ? due : due.set({ hour: 9, minute: 0 });
    await scheduleNudge(ctx.user.key, ctx.user.whatsapp, `Reminder: ${title}`, when.toISO()!, taskId);
  }
  return `Added to Family tracker: "${title}" on ${dateISO.slice(0, 10)}${remind ? " with a reminder" : ""}.`;
}

async function handleVaccinationSchedule(input: Json, ctx: AgentContext): Promise<string> {
  const child = str(input, "child_name") ?? "your child";
  const dob = str(input, "dob_iso");
  if (!dob) return "I need the child's date of birth (yyyy-mm-dd).";
  const schedule = buildImmunizationSchedule(dob, config.TIMEZONE);
  const now = DateTime.now().setZone(config.TIMEZONE);
  const capNudge = now.plus({ months: 24 });

  let created = 0;
  const upcoming: string[] = [];
  for (const v of schedule) {
    const due = DateTime.fromISO(v.dueDateTimeISO, { zone: config.TIMEZONE });
    if (due < now.startOf("day")) continue; // skip past vaccines (assumed done)
    const taskId = await createTaskPage({
      title: `💉 ${child} — ${v.label}`,
      authorName: ctx.user.name,
      due: v.dueISODate,
    });
    created++;
    if (due <= capNudge) {
      const remindAt = due.minus({ days: 3 });
      const when = remindAt < now ? due : remindAt;
      await scheduleNudge(
        ctx.user.key,
        ctx.user.whatsapp,
        `💉 ${child}'s vaccination due soon: ${v.label}`,
        when.toISO()!,
        taskId
      );
    }
    if (upcoming.length < 3) upcoming.push(`• ${v.label} — ${v.dueISODate}`);
  }
  if (!created) return `Looks like ${child}'s scheduled vaccines are all in the past — nothing upcoming to add.`;
  return `Set up ${created} upcoming vaccination(s) for ${child} as tracked tasks with reminders. Next up:\n${upcoming.join("\n")}\n\n(General India schedule — please confirm exact dates with your pediatrician.)`;
}

async function handleShoppingList(): Promise<string> {
  const items = await listCategoryCaptures("Shopping", 40);
  if (!items.length) return "Your shopping list is empty.";
  return "🛒 Shopping list:\n" + items.map((i) => `• ${i.transcript.slice(0, 80)}`).join("\n");
}

async function handleRemember(input: Json, ctx: AgentContext): Promise<string> {
  const fact = str(input, "fact") ?? "";
  if (!fact.trim()) return "Nothing to remember.";
  await rememberFact(fact, ctx.user.key);
  return `Got it — I'll remember: ${fact}`;
}

async function handleRecall(input: Json): Promise<string> {
  const q = str(input, "query") ?? "";
  const facts = await recallFacts(q, 5);
  if (!facts.length) return "I don't have anything stored about that.";
  return facts.map((f) => `- ${f.content}`).join("\n");
}

async function handleMessageStatus(input: Json): Promise<string> {
  const recipient = normalizePhone(str(input, "recipient") ?? "");
  const matchText = str(input, "match_text") ?? "";
  const res = await query<{
    recipient: string;
    body: string;
    status: string | null;
    status_at: string | null;
    error: string | null;
  }>(
    `SELECT recipient, body, status, status_at, error FROM outbound_messages
     WHERE ($1 = '' OR recipient LIKE '%' || $1 || '%')
       AND ($2 = '' OR body ILIKE '%' || $2 || '%')
     ORDER BY created_at DESC LIMIT 3`,
    [recipient, matchText]
  );
  if (!res.rows.length) return "I couldn't find a matching message I've sent.";
  return res.rows
    .map((r) => {
      const st = r.status ?? "pending";
      const label =
        st === "read" ? "✅ read" : st === "delivered" ? "📬 delivered (not read yet)" :
        st === "failed" ? `❌ failed${r.error ? ` (${r.error})` : ""}` : `sent (${st})`;
      return `"${r.body.slice(0, 60)}" → ${r.recipient}: ${label}`;
    })
    .join("\n");
}

async function handleListEvents(input: Json, ctx: AgentContext): Promise<string> {
  if (!(await isConnected(ctx.user.key))) return connectHint(ctx.user);
  const now = DateTime.now().setZone(config.TIMEZONE);
  const start = str(input, "start_iso") ?? now.toISO()!;
  const end = str(input, "end_iso") ?? now.plus({ hours: 24 }).toISO()!;
  const events = await listEvents(ctx.user.key, start, end);
  if (!events.length) return "No events in that window.";
  return events
    .map((e) => `• ${e.summary}${e.start ? ` — ${e.start}` : ""}`)
    .join("\n");
}

async function handleReminder(input: Json, ctx: AgentContext): Promise<string> {
  const message = str(input, "message") ?? "";
  const when = str(input, "when_iso");
  if (!when) return "Missing when_iso.";
  await scheduleReminder(ctx.user.key, ctx.user.name, ctx.user.whatsapp, message, when);
  return `Reminder set for ${when} and added to your Tasks in Notion. You can postpone it anytime by replying.`;
}

/** Build a 5-field cron (min hour * * dow) in app timezone from simple inputs. */
function buildCron(frequency: string, timeHHMM: string, dayOfWeek?: number): string | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(timeHHMM.trim());
  if (!m) return undefined;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return undefined;
  if (frequency === "daily") return `${minute} ${hour} * * *`;
  if (frequency === "weekdays") return `${minute} ${hour} * * 1-5`;
  if (frequency === "weekly") return `${minute} ${hour} * * ${dayOfWeek ?? 1}`;
  return undefined;
}

async function handleRecurringReminder(input: Json, ctx: AgentContext): Promise<string> {
  const message = str(input, "message") ?? "";
  const frequency = str(input, "frequency") ?? "daily";
  const time = str(input, "time_hhmm") ?? "";
  const next = str(input, "next_when_iso") ?? new Date().toISOString();
  const cron = buildCron(frequency, time, num(input, "day_of_week"));
  if (!cron) return "Could not build a schedule — need a valid frequency and time like 09:00.";
  await scheduleRecurringReminder(
    ctx.user.key,
    ctx.user.name,
    ctx.user.whatsapp,
    message,
    cron,
    config.TIMEZONE,
    next
  );
  const label = frequency === "weekly" ? "every week" : frequency === "weekdays" ? "every weekday" : "every day";
  return `Recurring reminder set: "${message}" ${label} at ${time} IST. Reply "stop" to end it.`;
}

async function handleSnooze(input: Json, ctx: AgentContext): Promise<string> {
  const when = str(input, "new_when_iso");
  if (!when) return "Missing new time.";
  const res = await snoozeReminder(ctx.user.key, when, str(input, "match_text"));
  return res.ok
    ? `Postponed "${res.body}" to ${when}.`
    : "I couldn't find an active reminder to postpone.";
}

async function handleStop(input: Json, ctx: AgentContext): Promise<string> {
  const res = await stopReminder(ctx.user.key, str(input, "match_text"));
  return res.ok ? `Stopped the reminder "${res.body}".` : "I couldn't find a reminder to stop.";
}

async function handleMarkDone(input: Json, ctx: AgentContext): Promise<string> {
  const matchText = str(input, "match_text");
  if (matchText) {
    // Match any open task by title (covers reminders AND Idea-derived tasks).
    const task = await findOpenTaskByText(matchText);
    if (!task) return `I couldn't find an open task matching "${matchText}".`;
    await markTaskDone(task.id);
    await completeReminderByTaskId(ctx.user.key, task.id);
    return `Marked "${task.title}" as done. ✅`;
  }
  // No text: complete the user's most recent reminder.
  const row = await latestReminderWithTask(ctx.user.key);
  if (!row?.notion_task_id) return "Which task should I mark done? Tell me a word or two from it.";
  await markTaskDone(row.notion_task_id);
  await completeReminderRow(row);
  return `Marked "${row.body}" as done. ✅`;
}

async function handleListReminders(ctx: AgentContext): Promise<string> {
  const items = await listReminders(ctx.user.key);
  if (!items.length) return "You have no active reminders.";
  return items
    .map((r) => `• ${r.body}${r.recurring ? " (recurring)" : ` — ${new Date(r.send_at).toISOString()}`}`)
    .join("\n");
}

async function handleOutbound(input: Json, ctx: AgentContext): Promise<string> {
  const recipient = normalizePhone(str(input, "recipient_number") ?? "");
  const message = str(input, "message") ?? "";
  const when = str(input, "when_iso");
  if (!recipient || !when) return "Missing recipient_number or when_iso.";
  const id = await scheduleOutboundPending(ctx.user.key, recipient, message, when);
  return `Prepared (id ${id}) but NOT sent yet: to ${str(input, "recipient_name") ?? recipient} at ${when}: "${message}". Ask the user to confirm.`;
}

async function handleConfirm(ctx: AgentContext): Promise<string> {
  const pending = await latestPendingConfirmation(ctx.user.key);
  if (!pending) return "No pending message to confirm.";
  const ok = await confirmScheduled(pending.id);
  return ok
    ? `Confirmed. Will send to ${pending.recipient} at ${new Date(pending.send_at).toISOString()}.`
    : "Could not confirm.";
}

async function handleCancel(ctx: AgentContext): Promise<string> {
  const pending = await latestPendingConfirmation(ctx.user.key);
  if (!pending) return "No pending message to cancel.";
  await cancelScheduled(pending.id);
  return "Cancelled the pending message.";
}

async function handleCreateEvent(input: Json, ctx: AgentContext): Promise<string> {
  if (!(await isConnected(ctx.user.key))) return connectHint(ctx.user);
  const res = await createEvent(ctx.user.key, {
    summary: str(input, "summary") ?? "Event",
    startISO: str(input, "start_iso") ?? new Date().toISOString(),
    endISO: str(input, "end_iso"),
    description: str(input, "description"),
    location: str(input, "location"),
    reminderMinutes: num(input, "reminder_minutes"),
  });
  return res.ok ? `Event created: ${res.htmlLink}` : `Failed: ${res.error}`;
}

async function handleUpdateEvent(input: Json, ctx: AgentContext): Promise<string> {
  if (!(await isConnected(ctx.user.key))) return connectHint(ctx.user);
  const q = str(input, "query") ?? "";
  const found = await findEvents(ctx.user.key, q, 3);
  if (!found.length) return `No upcoming event matching "${q}".`;
  if (found.length > 1) {
    return `Multiple matches, ask which: ${found.map((f) => `${f.summary} (${f.start})`).join("; ")}`;
  }
  const res = await updateEvent(ctx.user.key, found[0]!.id, {
    summary: str(input, "summary"),
    startISO: str(input, "start_iso"),
    endISO: str(input, "end_iso"),
    reminderMinutes: num(input, "reminder_minutes"),
  });
  return res.ok ? `Updated "${found[0]!.summary}".` : `Failed: ${res.error}`;
}

async function handleDeleteEvent(input: Json, ctx: AgentContext): Promise<string> {
  if (!(await isConnected(ctx.user.key))) return connectHint(ctx.user);
  const q = str(input, "query") ?? "";
  const found = await findEvents(ctx.user.key, q, 3);
  if (!found.length) return `No upcoming event matching "${q}".`;
  if (found.length > 1) {
    return `Multiple matches, ask which: ${found.map((f) => `${f.summary} (${f.start})`).join("; ")}`;
  }
  const res = await deleteEvent(ctx.user.key, found[0]!.id);
  return res.ok ? `Deleted "${found[0]!.summary}".` : `Failed: ${res.error}`;
}

async function handleSearchGmail(input: Json, ctx: AgentContext): Promise<string> {
  if (!(await isConnected(ctx.user.key))) return connectHint(ctx.user);
  const hits = await searchEmail(ctx.user.key, str(input, "query") ?? "", num(input, "limit") ?? 5);
  if (!hits.length) return "No matching email.";
  return hits.map((h, i) => `${i + 1}. ${h.from} — ${h.subject}: ${h.snippet.slice(0, 120)}`).join("\n");
}

async function handleDraftEmail(input: Json, ctx: AgentContext): Promise<string> {
  if (!(await isConnected(ctx.user.key))) return connectHint(ctx.user);
  const res = await createDraft(
    ctx.user.key,
    str(input, "to") ?? "",
    str(input, "subject") ?? "",
    str(input, "body") ?? ""
  );
  return res.ok ? "Draft created in Gmail (not sent)." : `Failed: ${res.error}`;
}
