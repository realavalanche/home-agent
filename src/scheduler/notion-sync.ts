import { config } from "../config.js";
import { logger } from "../logger.js";
import { query } from "../db/pool.js";
import { notion } from "../notion/client.js";
import { updateCaptureText, deleteCaptureRow } from "../search/store.js";

/**
 * Keep the Postgres search index faithful to Notion. Notion is the human record,
 * so if a capture is edited or deleted there, we reconcile it here: changed text
 * is re-embedded, changed category is updated, and captures trashed in Notion are
 * removed from the index. Runs on a timer (reconcile is simple and idempotent).
 */
export async function runNotionSync(): Promise<void> {
  const dsId = config.NOTION_DS_CAPTURES;
  if (!dsId) return;

  // 1) Snapshot every (non-trashed) Captures page currently in Notion.
  const notionPages = new Map<string, { transcript: string; category: string }>();
  let cursor: string | undefined;
  do {
    const res = (await notion.dataSources.query({
      data_source_id: dsId,
      page_size: 100,
      start_cursor: cursor,
    } as never)) as {
      results: { id: string; properties?: Record<string, unknown> }[];
      has_more: boolean;
      next_cursor: string | null;
    };
    for (const page of res.results) {
      const t = page.properties?.Transcript as { rich_text?: { plain_text?: string }[] } | undefined;
      const c = page.properties?.Category as { select?: { name?: string } } | undefined;
      notionPages.set(page.id, {
        transcript: t?.rich_text?.map((r) => r.plain_text ?? "").join("") ?? "",
        category: c?.select?.name ?? "",
      });
    }
    cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
  } while (cursor);

  // 2) Compare with the Postgres mirror.
  const pg = await query<{ id: number; notion_page_id: string; transcript: string; category: string }>(
    `SELECT id, notion_page_id, transcript, category FROM captures WHERE notion_page_id IS NOT NULL`
  );

  let updated = 0;
  let deleted = 0;
  for (const row of pg.rows) {
    const n = notionPages.get(row.notion_page_id);
    if (!n) {
      // Trashed/removed in Notion → drop from the index.
      await deleteCaptureRow(row.id);
      deleted++;
      continue;
    }
    if (n.transcript && n.transcript !== row.transcript) {
      await updateCaptureText(row.id, n.transcript); // re-embeds
      updated++;
    }
    if (n.category && n.category !== row.category) {
      await query(`UPDATE captures SET category = $2 WHERE id = $1`, [row.id, n.category]);
      updated++;
    }
  }

  if (updated || deleted) logger.info("notion sync reconciled", { updated, deleted });
}
