import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pool } from "./pool.js";

/** Apply schema.sql idempotently. Run with `npm run migrate`. */
async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  // In dev we run the .ts via tsx (here = src/db); the .sql lives alongside it.
  const sqlPath = join(here, "schema.sql");
  const sql = await readFile(sqlPath, "utf8");
  await pool.query(sql);
  console.log("✓ schema applied");
  await pool.end();
}

main().catch((err) => {
  console.error("migration failed:", err);
  process.exit(1);
});
