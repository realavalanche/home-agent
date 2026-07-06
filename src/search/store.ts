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
  source: "voice" | "text";
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
