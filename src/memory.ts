import { query } from "./db/pool.js";
import type { AuthorKey } from "./users.js";

/**
 * Short-term conversation memory. Each user has one running thread with the bot;
 * we replay the recent turns so the agent can follow multi-message exchanges
 * (give a name, then a number, then the text). Long-term recall of past *notes*
 * is handled separately by semantic search over captures.
 *
 * Bounded by a turn count + time window so token cost stays small and stale,
 * unrelated context doesn't leak into a fresh conversation.
 */
// Kept tight: enough to follow an active back-and-forth (give a name, then a
// number, then the text), but short enough that older, already-handled items
// don't linger in context and get re-surfaced in unrelated replies.
const MAX_TURNS = 12;
const WINDOW_MINUTES = 60;

export interface Turn {
  role: "user" | "assistant";
  content: string;
}

/** Recent turns for a user, oldest→newest, ready to prepend to the agent. */
export async function loadRecentTurns(authorKey: AuthorKey): Promise<Turn[]> {
  const res = await query<{ role: string; content: string }>(
    `SELECT role, content FROM conversation_turns
     WHERE author_key = $1 AND created_at > now() - ($2 || ' minutes')::interval
     ORDER BY created_at DESC LIMIT $3`,
    [authorKey, String(WINDOW_MINUTES), MAX_TURNS]
  );
  return res.rows
    .reverse()
    .map((r) => ({ role: r.role === "assistant" ? "assistant" : "user", content: r.content }));
}

/** Persist one exchange (the user's message + the bot's reply) as two turns. */
export async function saveTurns(
  authorKey: AuthorKey,
  userText: string,
  assistantText: string
): Promise<void> {
  await query(
    `INSERT INTO conversation_turns (author_key, role, content)
     VALUES ($1,'user',$2),($1,'assistant',$3)`,
    [authorKey, userText, assistantText]
  );
}
