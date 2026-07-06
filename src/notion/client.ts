import { Client } from "@notionhq/client";
import { config } from "../config.js";

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

/** Notion rich_text/title helper. */
export function text(content: string) {
  return [{ type: "text" as const, text: { content: content.slice(0, 2000) } }];
}
