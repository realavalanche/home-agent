import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pool } from "./pool.js";

// Postgres can be briefly unreachable when Railway restarts both services at
// once (this is what took us down on 2026-08-13). Wait it out instead of
// exiting, so a restart doesn't burn through the restart budget.
const MAX_ATTEMPTS = 20;
const RETRY_DELAY_MS = 5_000;

/** Apply schema.sql idempotently. Run with `npm run migrate`. */
async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  // In dev we run the .ts via tsx (here = src/db); the .sql lives alongside it.
  const sqlPath = join(here, "schema.sql");
  const sql = await readFile(sqlPath, "utf8");
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query(sql);
      break;
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) throw err;
      console.warn(`migration attempt ${attempt}/${MAX_ATTEMPTS} failed, retrying:`, String(err));
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }
  console.log("✓ schema applied");
  await pool.end();
}

main().catch((err) => {
  console.error("migration failed:", err);
  process.exit(1);
});
