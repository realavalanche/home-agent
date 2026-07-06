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
