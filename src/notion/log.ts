import { notion, text } from "./client.js";
import { config } from "../config.js";
import type { Category, MealSubcategory } from "../categorize.js";
import type { AuthorKey } from "../users.js";

function requireDs(id: string | undefined, which: string): string {
  if (!id) throw new Error(`Missing ${which}. Run \`npm run setup:notion\` first.`);
  return id;
}

export interface CaptureInput {
  title: string;
  authorKey: AuthorKey;
  authorName: string;
  category: Category;
  subcategory?: MealSubcategory;
  transcript: string;
  language: string;
  source: "voice" | "text";
  relatedPageIds?: string[];
}

/** Create a Captures row and return its page id. */
export async function createCapturePage(input: CaptureInput): Promise<string> {
  const dsId = requireDs(config.NOTION_DS_CAPTURES, "NOTION_DS_CAPTURES");
  const properties: Record<string, unknown> = {
    Title: { title: text(input.title) },
    Author: { select: { name: input.authorName } },
    Category: { select: { name: input.category } },
    Transcript: { rich_text: text(input.transcript) },
    Language: { select: { name: input.language } },
    Source: { select: { name: input.source } },
  };
  if (input.subcategory) properties.Subcategory = { select: { name: input.subcategory } };
  if (input.relatedPageIds?.length) {
    properties.Related = { relation: input.relatedPageIds.map((id) => ({ id })) };
  }

  const page = await notion.pages.create({
    parent: { type: "data_source_id", data_source_id: dsId },
    properties: properties as never,
  });
  return page.id;
}

/** Send a capture page to Notion's trash (used for delete/undo). */
export async function archiveCapturePage(pageId: string): Promise<void> {
  await notion.pages.update({ page_id: pageId, in_trash: true } as never);
}

/** Update a capture page's transcript and/or category (used for edit). */
export async function updateCapturePage(
  pageId: string,
  changes: { transcript?: string; category?: Category; title?: string }
): Promise<void> {
  const properties: Record<string, unknown> = {};
  if (changes.transcript) properties.Transcript = { rich_text: text(changes.transcript) };
  if (changes.category) properties.Category = { select: { name: changes.category } };
  if (changes.title) properties.Title = { title: text(changes.title) };
  if (Object.keys(properties).length === 0) return;
  await notion.pages.update({ page_id: pageId, properties: properties as never });
}

/** Attach related-note relations to an existing capture (auto-link on ingest). */
export async function linkRelated(pageId: string, relatedPageIds: string[]): Promise<void> {
  if (!relatedPageIds.length) return;
  await notion.pages.update({
    page_id: pageId,
    properties: {
      Related: { relation: relatedPageIds.map((id) => ({ id })) },
    } as never,
  });
}

export interface TaskInput {
  title: string;
  authorName: string;
  due?: string; // ISO date/datetime
  sourceIdeaPageId?: string;
}

/** Create a Task row, optionally linked back to the Idea it came from. */
export async function createTaskPage(input: TaskInput): Promise<string> {
  const dsId = requireDs(config.NOTION_DS_TASKS, "NOTION_DS_TASKS");
  const properties: Record<string, unknown> = {
    Title: { title: text(input.title) },
    Author: { select: { name: input.authorName } },
    Status: { select: { name: "To Do" } },
  };
  if (input.due) properties.Due = { date: { start: input.due } };
  if (input.sourceIdeaPageId) {
    properties["Source Idea"] = { relation: [{ id: input.sourceIdeaPageId }] };
  }
  const page = await notion.pages.create({
    parent: { type: "data_source_id", data_source_id: dsId },
    properties: properties as never,
  });
  return page.id;
}

/** Move a task's Due date (used when a reminder is snoozed/postponed). */
export async function updateTaskDue(pageId: string, dueISO: string): Promise<void> {
  await notion.pages.update({
    page_id: pageId,
    properties: { Due: { date: { start: dueISO } } } as never,
  });
}

/** Mark a task done (used when a recurring reminder is stopped). */
export async function markTaskDone(pageId: string): Promise<void> {
  await notion.pages.update({
    page_id: pageId,
    properties: { Status: { select: { name: "Done" } } } as never,
  });
}

/** Find the best-matching open (not Done) Task by title text. */
export async function findOpenTaskByText(
  text: string
): Promise<{ id: string; title: string } | undefined> {
  const dsId = requireDs(config.NOTION_DS_TASKS, "NOTION_DS_TASKS");
  const res = await notion.dataSources.query({
    data_source_id: dsId,
    filter: {
      and: [
        { property: "Title", title: { contains: text } },
        { property: "Status", select: { does_not_equal: "Done" } },
      ],
    },
    page_size: 5,
  } as never);
  const page = res.results[0] as { id: string; properties?: Record<string, unknown> } | undefined;
  if (!page) return undefined;
  const titleProp = page.properties?.Title as { title?: { plain_text?: string }[] } | undefined;
  const title = titleProp?.title?.map((t) => t.plain_text ?? "").join("") || text;
  return { id: page.id, title };
}

/** List a user's overdue tasks (Due before today, not Done). */
export async function listOverdueTasks(
  authorName: string,
  todayISODate: string
): Promise<{ title: string; due: string }[]> {
  if (!config.NOTION_DS_TASKS) return [];
  const res = await notion.dataSources.query({
    data_source_id: config.NOTION_DS_TASKS,
    filter: {
      and: [
        { property: "Author", select: { equals: authorName } },
        { property: "Status", select: { does_not_equal: "Done" } },
        { property: "Due", date: { before: todayISODate } },
      ],
    },
    page_size: 25,
  } as never);
  return (res.results as { properties?: Record<string, unknown> }[]).map((page) => {
    const titleProp = page.properties?.Title as { title?: { plain_text?: string }[] } | undefined;
    const dueProp = page.properties?.Due as { date?: { start?: string } } | undefined;
    return {
      title: titleProp?.title?.map((t) => t.plain_text ?? "").join("") || "(untitled)",
      due: dueProp?.date?.start ?? "",
    };
  });
}

export interface WeeklyReviewInput {
  title: string;
  authorName: string;
  markdown: string;
}

/** Post a weekly review as a Notion page with the summary in the body. */
export async function createWeeklyReviewPage(input: WeeklyReviewInput): Promise<string> {
  const dsId = requireDs(config.NOTION_DS_WEEKLY, "NOTION_DS_WEEKLY");
  const page = await notion.pages.create({
    parent: { type: "data_source_id", data_source_id: dsId },
    properties: {
      Title: { title: text(input.title) },
      Author: { select: { name: input.authorName } },
    } as never,
    children: paragraphs(input.markdown),
  });
  return page.id;
}

/** Split text into Notion paragraph blocks (2000-char limit per block). */
function paragraphs(body: string) {
  return body
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => ({
      object: "block" as const,
      type: "paragraph" as const,
      paragraph: { rich_text: text(line) },
    }));
}
