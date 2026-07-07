import { query, toVector } from "./db/pool.js";
import { embed } from "./search/embed.js";
import type { AuthorKey } from "./users.js";

/**
 * Durable facts memory. Unlike the 3-hour conversation buffer, these persist
 * forever and are recalled by meaning — so a phone number, a birthday, or an
 * address given once can be pulled back months later. Household-shared.
 */

/** Store a durable fact (embedded for later semantic recall). */
export async function rememberFact(content: string, addedBy: AuthorKey): Promise<void> {
  const trimmed = content.trim();
  if (!trimmed) return;
  const vec = await embed(trimmed, "document");
  await query(
    `INSERT INTO facts (content, embedding, added_by) VALUES ($1, $2, $3)`,
    [trimmed, toVector(vec), addedBy]
  );
}

export interface RecalledFact {
  content: string;
  similarity: number;
}

/** Recall the facts most relevant to a query, best match first. */
export async function recallFacts(queryText: string, limit = 5): Promise<RecalledFact[]> {
  const vec = await embed(queryText, "query");
  const res = await query<{ content: string; similarity: number }>(
    `SELECT content, 1 - (embedding <=> $1) AS similarity
     FROM facts
     WHERE embedding IS NOT NULL
     ORDER BY embedding <=> $1
     LIMIT $2`,
    [toVector(vec), limit]
  );
  return res.rows.map((r) => ({ content: r.content, similarity: Number(r.similarity) }));
}
