import { query, toVector } from "../db/pool.js";
import { embed } from "./embed.js";
import type { AuthorKey } from "../users.js";
import type { Category } from "../categorize.js";

/**
 * pgvector-backed capture index. One row per capture mirrors the Notion page and
 * holds its embedding for semantic search (requirement 7) and auto-linking
 * (requirement 8). Notion stays the human-facing record; this is the machine one.
 */

export interface StoreCaptureInput {
  waMessageId: string;
  authorKey: AuthorKey;
  authorName: string;
  source: "voice" | "text" | "image";
  languageCode: string;
  transcript: string;
  category: Category;
  subcategory?: string;
  notionPageId: string;
}

/** Insert a capture row with its embedding. Returns the row id. */
export async function storeCapture(input: StoreCaptureInput): Promise<number> {
  const vec = await embed(input.transcript, "document");
  const res = await query<{ id: number }>(
    `INSERT INTO captures
       (wa_message_id, author_key, author_name, source, language_code,
        transcript, category, subcategory, notion_page_id, embedding)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (wa_message_id) DO UPDATE SET transcript = EXCLUDED.transcript
     RETURNING id`,
    [
      input.waMessageId,
      input.authorKey,
      input.authorName,
      input.source,
      input.languageCode,
      input.transcript,
      input.category,
      input.subcategory ?? null,
      input.notionPageId,
      toVector(vec),
    ]
  );
  return res.rows[0]!.id;
}

export interface RelatedNote {
  id: number;
  transcript: string;
  category: string;
  notionPageId: string;
  authorName: string;
  createdAt: string;
  similarity: number;
}

/**
 * Semantic search over all captures (both users, shared brain). `queryText` is
 * embedded as a query. Returns nearest neighbours by cosine similarity.
 */
export async function semanticSearch(queryText: string, limit = 5): Promise<RelatedNote[]> {
  const vec = await embed(queryText, "query");
  const res = await query<RelatedNoteRow>(
    `SELECT id, transcript, category, notion_page_id, author_name, created_at,
            1 - (embedding <=> $1) AS similarity
     FROM captures
     WHERE embedding IS NOT NULL
     ORDER BY embedding <=> $1
     LIMIT $2`,
    [toVector(vec), limit]
  );
  return res.rows.map(mapRow);
}

/**
 * Find notes related to an existing capture's embedding, for auto-linking on
 * ingest. Excludes the capture itself and applies a similarity floor so we only
 * link genuinely related items.
 */
export async function findRelated(
  captureId: number,
  minSimilarity = 0.55,
  limit = 3
): Promise<RelatedNote[]> {
  const res = await query<RelatedNoteRow>(
    `WITH target AS (SELECT embedding FROM captures WHERE id = $1)
     SELECT c.id, c.transcript, c.category, c.notion_page_id, c.author_name, c.created_at,
            1 - (c.embedding <=> t.embedding) AS similarity
     FROM captures c, target t
     WHERE c.id <> $1 AND c.embedding IS NOT NULL
     ORDER BY c.embedding <=> t.embedding
     LIMIT $2`,
    [captureId, limit]
  );
  return res.rows.map(mapRow).filter((r) => r.similarity >= minSimilarity);
}

export interface CaptureRef {
  id: number;
  transcript: string;
  category: string;
  notionPageId: string;
  createdAt: string;
}

/** Find a user's captures by recency, optionally biased to a text match. */
export async function findRecentCaptures(
  authorKey: AuthorKey,
  matchText = "",
  limit = 5
): Promise<CaptureRef[]> {
  const res = await query<{
    id: number;
    transcript: string;
    category: string;
    notion_page_id: string;
    created_at: string;
  }>(
    `SELECT id, transcript, category, notion_page_id, created_at
     FROM captures
     WHERE author_key = $1 AND ($2 = '' OR transcript ILIKE '%' || $2 || '%')
     ORDER BY (($2 <> '') AND transcript ILIKE '%' || $2 || '%') DESC, created_at DESC
     LIMIT $3`,
    [authorKey, matchText, limit]
  );
  return res.rows.map((r) => ({
    id: r.id,
    transcript: r.transcript,
    category: r.category,
    notionPageId: r.notion_page_id,
    createdAt: typeof r.created_at === "string" ? r.created_at : new Date(r.created_at).toISOString(),
  }));
}

/** List the household's captures in a category (e.g. Shopping) — a running list. */
export async function listCategoryCaptures(category: string, limit = 40): Promise<CaptureRef[]> {
  const res = await query<{
    id: number;
    transcript: string;
    category: string;
    notion_page_id: string;
    created_at: string;
  }>(
    `SELECT id, transcript, category, notion_page_id, created_at
     FROM captures WHERE category = $1 ORDER BY created_at DESC LIMIT $2`,
    [category, limit]
  );
  return res.rows.map((r) => ({
    id: r.id,
    transcript: r.transcript,
    category: r.category,
    notionPageId: r.notion_page_id,
    createdAt: typeof r.created_at === "string" ? r.created_at : new Date(r.created_at).toISOString(),
  }));
}

/** Delete a capture from the Postgres index (Notion page is archived separately). */
export async function deleteCaptureRow(id: number): Promise<void> {
  await query(`DELETE FROM captures WHERE id = $1`, [id]);
}

/** Update a capture's text + re-embed it so search stays accurate. */
export async function updateCaptureText(id: number, newText: string): Promise<void> {
  const vec = await embed(newText, "document");
  await query(`UPDATE captures SET transcript = $2, embedding = $3 WHERE id = $1`, [
    id,
    newText,
    toVector(vec),
  ]);
}

interface RelatedNoteRow {
  id: number;
  transcript: string;
  category: string;
  notion_page_id: string;
  author_name: string;
  created_at: string;
  similarity: number;
}

function mapRow(r: RelatedNoteRow): RelatedNote {
  return {
    id: r.id,
    transcript: r.transcript,
    category: r.category,
    notionPageId: r.notion_page_id,
    authorName: r.author_name,
    createdAt: typeof r.created_at === "string" ? r.created_at : new Date(r.created_at).toISOString(),
    similarity: Number(r.similarity),
  };
}
