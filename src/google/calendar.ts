import { google } from "googleapis";
import { config } from "../config.js";
import { getAuthedClient } from "./auth.js";
import type { AuthorKey } from "../users.js";

/**
 * Google Calendar CRUD for a specific user. Times are interpreted in the app
 * timezone (IST) unless an explicit offset is given. Reminders are attached as
 * popup overrides.
 */

export interface EventInput {
  summary: string;
  startISO: string; // e.g. 2026-07-06T15:00:00 (treated as IST if no offset)
  endISO?: string; // defaults to +1h
  description?: string;
  location?: string;
  reminderMinutes?: number; // popup reminder before start
}

interface CalResult {
  ok: boolean;
  eventId?: string;
  htmlLink?: string;
  error?: string;
}

async function calendarFor(authorKey: AuthorKey) {
  const auth = await getAuthedClient(authorKey);
  if (!auth) return undefined;
  return google.calendar({ version: "v3", auth });
}

function addHour(iso: string): string {
  const d = new Date(iso);
  return new Date(d.getTime() + 60 * 60 * 1000).toISOString();
}

export async function createEvent(authorKey: AuthorKey, input: EventInput): Promise<CalResult> {
  const cal = await calendarFor(authorKey);
  if (!cal) return { ok: false, error: "not_connected" };
  const res = await cal.events.insert({
    calendarId: "primary",
    requestBody: {
      summary: input.summary,
      description: input.description,
      location: input.location,
      start: { dateTime: input.startISO, timeZone: config.TIMEZONE },
      end: { dateTime: input.endISO ?? addHour(input.startISO), timeZone: config.TIMEZONE },
      reminders: input.reminderMinutes
        ? { useDefault: false, overrides: [{ method: "popup", minutes: input.reminderMinutes }] }
        : { useDefault: true },
    },
  });
  return { ok: true, eventId: res.data.id ?? undefined, htmlLink: res.data.htmlLink ?? undefined };
}

export async function updateEvent(
  authorKey: AuthorKey,
  eventId: string,
  input: Partial<EventInput>
): Promise<CalResult> {
  const cal = await calendarFor(authorKey);
  if (!cal) return { ok: false, error: "not_connected" };
  const patch: Record<string, unknown> = {};
  if (input.summary) patch.summary = input.summary;
  if (input.description) patch.description = input.description;
  if (input.location) patch.location = input.location;
  if (input.startISO) patch.start = { dateTime: input.startISO, timeZone: config.TIMEZONE };
  if (input.endISO) patch.end = { dateTime: input.endISO, timeZone: config.TIMEZONE };
  if (input.reminderMinutes) {
    patch.reminders = { useDefault: false, overrides: [{ method: "popup", minutes: input.reminderMinutes }] };
  }
  const res = await cal.events.patch({ calendarId: "primary", eventId, requestBody: patch });
  return { ok: true, eventId: res.data.id ?? undefined, htmlLink: res.data.htmlLink ?? undefined };
}

export async function deleteEvent(authorKey: AuthorKey, eventId: string): Promise<CalResult> {
  const cal = await calendarFor(authorKey);
  if (!cal) return { ok: false, error: "not_connected" };
  await cal.events.delete({ calendarId: "primary", eventId });
  return { ok: true, eventId };
}

export interface FoundEvent {
  id: string;
  summary: string;
  start?: string;
  htmlLink?: string;
}

/** Search upcoming events by text — used to find the event to update/delete. */
export async function findEvents(authorKey: AuthorKey, q: string, max = 5): Promise<FoundEvent[]> {
  const cal = await calendarFor(authorKey);
  if (!cal) return [];
  const res = await cal.events.list({
    calendarId: "primary",
    q,
    maxResults: max,
    singleEvents: true,
    orderBy: "startTime",
    timeMin: new Date().toISOString(),
  });
  return (res.data.items ?? []).map((e) => ({
    id: e.id ?? "",
    summary: e.summary ?? "(no title)",
    start: e.start?.dateTime ?? e.start?.date ?? undefined,
    htmlLink: e.htmlLink ?? undefined,
  }));
}
