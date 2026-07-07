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
} from "../notion/log.js";
import { storeCapture, semanticSearch, findRelated } from "../search/store.js";
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
import { createEvent, updateEvent, deleteEvent, findEvents } from "../google/calendar.js";
import { searchEmail, createDraft } from "../google/gmail.js";
import { isConnected } from "../google/auth.js";
import { normalizePhone } from "../config.js";

export interface AgentContext {
  user: User;
  waMessageId: string;
  transcript: string;
  language: string;
  source: "voice" | "text";
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
