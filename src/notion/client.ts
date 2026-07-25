import { Client } from "@notionhq/client";
import { config } from "../config.js";
import { logger } from "../logger.js";

/**
 * Shared Notion client. We pin the 2025-09-03 API version: in it a "database" is
 * a container and its columns/rows live in a child "data source". Pages are
 * therefore created under a `data_source_id`, and we query data sources (not
 * databases) for search/auto-link. The setup script stores both ids in env.
 */
export const notion = new Client({
  auth: config.NOTION_TOKEN,
  notionVersion: "2025-09-03",
});

/**
 * Notion allows only ~3 requests/second, and creating several tasks at once
 * (e.g. splitting a list into 6, each of which writes a page + relations) blew
 * past that. Retrying after a 429 wasn't enough because many calls collided.
 *
 * So we do two things:
 *  1) THROTTLE — every Notion call goes through one global serial queue that
 *     spaces calls ~400ms apart (~2.5/s), staying safely under the limit so we
 *     rarely hit 429 at all.
 *  2) RETRY — anything that still 429s is retried with backoff (honoring
 *     Retry-After) as a backstop.
 */
const MIN_INTERVAL_MS = 400;
let notionChain: Promise<void> = Promise.resolve();
let lastCallAt = 0;

/** Wait our turn in the global serial queue, spaced by MIN_INTERVAL_MS. */
function throttle(): Promise<void> {
  const mine = notionChain.then(async () => {
    const wait = Math.max(0, lastCallAt + MIN_INTERVAL_MS - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallAt = Date.now();
  });
  notionChain = mine.catch(() => {});
  return mine;
}

export async function withNotionRetry<T>(fn: () => Promise<T>, label = "notion"): Promise<T> {
  const MAX_ATTEMPTS = 6;
  for (let attempt = 0; ; attempt++) {
    await throttle();
    try {
      return await fn();
    } catch (err) {
      const e = err as { code?: string; status?: number; headers?: Record<string, string> };
      const rateLimited = e?.code === "rate_limited" || e?.status === 429;
      if (!rateLimited || attempt >= MAX_ATTEMPTS - 1) throw err;
      const retryAfter = Number(e?.headers?.["retry-after"]);
      const waitMs = retryAfter > 0 ? retryAfter * 1000 : Math.min(600 * 2 ** attempt, 10000);
      logger.warn("notion rate-limited, backing off", { label, attempt, waitMs });
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

// Rate-limit-safe wrappers around the mutating/query calls used across the app.
export function notionCreatePage(args: Parameters<typeof notion.pages.create>[0]) {
  return withNotionRetry(() => notion.pages.create(args), "pages.create");
}
export function notionUpdatePage(args: Parameters<typeof notion.pages.update>[0]) {
  return withNotionRetry(() => notion.pages.update(args), "pages.update");
}
export function notionQueryDataSource(args: Parameters<typeof notion.dataSources.query>[0]) {
  return withNotionRetry(() => notion.dataSources.query(args), "dataSources.query");
}

/** Notion rich_text/title helper. */
export function text(content: string) {
  return [{ type: "text" as const, text: { content: content.slice(0, 2000) } }];
}
