import pg from "pg";
import { config } from "../config.js";

/**
 * Shared Postgres connection pool. pgvector returns vectors as strings; the
 * helpers below convert to/from the `[1,2,3]` text form pgvector expects.
 */
export const pool = new pg.Pool({ connectionString: config.DATABASE_URL });

/** Format a number[] as a pgvector literal, e.g. '[0.1,0.2]'. */
export function toVector(values: number[]): string {
  return `[${values.join(",")}]`;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params);
}
