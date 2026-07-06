import "dotenv/config";
import { readFile, writeFile } from "node:fs/promises";
import { Client } from "@notionhq/client";
import { CATEGORIES, MEAL_SUBCATEGORIES } from "../src/categorize.js";

/**
 * Idempotent-ish provisioner: creates the Captures, Tasks, and Weekly Reviews
 * databases under NOTION_PARENT_PAGE_ID and writes their database + data-source
 * ids back into .env. Re-running creates fresh databases (Notion has no
 * "create if not exists"), so run once. To reset, delete the .env ids + the
 * Notion databases first.
 *
 * Uses the 2025-09-03 API: `databases.create` returns a database whose first
 * data source id is what pages are created under.
 */

const token = process.env.NOTION_TOKEN;
const parent = process.env.NOTION_PARENT_PAGE_ID;
if (!token) throw new Error("NOTION_TOKEN not set");
if (!parent) throw new Error("NOTION_PARENT_PAGE_ID not set");

const notion = new Client({ auth: token, notionVersion: "2025-09-03" });

const authorNames = [process.env.USER_A_NAME ?? "User A", process.env.USER_B_NAME ?? "User B"];

function title(content: string) {
  return [{ type: "text" as const, text: { content } }];
}
function selectOptions(names: readonly string[]) {
  return { options: names.map((name) => ({ name })) };
}

interface Created {
  databaseId: string;
  dataSourceId: string;
}

async function createDatabase(
  name: string,
  properties: Record<string, unknown>
): Promise<Created> {
  const res = (await notion.databases.create({
    parent: { type: "page_id", page_id: parent! },
    title: title(name),
    initial_data_source: { properties: properties as never },
  })) as unknown as { id: string; data_sources?: Array<{ id: string }> };
  const dataSourceId = res.data_sources?.[0]?.id;
  if (!dataSourceId) throw new Error(`No data source returned for ${name}`);
  console.log(`✓ created ${name}: db=${res.id} ds=${dataSourceId}`);
  return { databaseId: res.id, dataSourceId };
}

async function main() {
  // 1) Captures (the hub). Related self-relation is added after we know its ds id.
  const captures = await createDatabase("Home-Agent · Captures", {
    Title: { title: {} },
    Author: { select: selectOptions(authorNames) },
    Category: { select: selectOptions(CATEGORIES) },
    Subcategory: { select: selectOptions(MEAL_SUBCATEGORIES) },
    Transcript: { rich_text: {} },
    Language: { select: {} },
    Source: { select: selectOptions(["voice", "text"]) },
    Created: { created_time: {} },
  });

  // 2) Tasks — linked back to the Idea/Capture it came from.
  const tasks = await createDatabase("Home-Agent · Tasks", {
    Title: { title: {} },
    Author: { select: selectOptions(authorNames) },
    Status: { select: selectOptions(["To Do", "Doing", "Done"]) },
    Due: { date: {} },
    "Source Idea": {
      type: "relation",
      relation: { data_source_id: captures.dataSourceId, single_property: {} },
    },
    Created: { created_time: {} },
  });

  // 3) Weekly reviews.
  const weekly = await createDatabase("Home-Agent · Weekly Reviews", {
    Title: { title: {} },
    Author: { select: selectOptions(authorNames) },
    Created: { created_time: {} },
  });

  // 4) Add the Captures self-relation ("Related") now that we have its ds id.
  await notion.dataSources.update({
    data_source_id: captures.dataSourceId,
    properties: {
      Related: {
        type: "relation",
        relation: { data_source_id: captures.dataSourceId, single_property: {} },
      },
    } as never,
  });
  console.log("✓ added Related self-relation on Captures");

  await writeEnv({
    NOTION_DB_CAPTURES: captures.databaseId,
    NOTION_DS_CAPTURES: captures.dataSourceId,
    NOTION_DB_TASKS: tasks.databaseId,
    NOTION_DS_TASKS: tasks.dataSourceId,
    NOTION_DB_WEEKLY: weekly.databaseId,
    NOTION_DS_WEEKLY: weekly.dataSourceId,
  });
  console.log("\n✓ wrote database ids to .env. Setup complete.");
}

/** Update or append the given keys in ./.env. */
async function writeEnv(vars: Record<string, string>) {
  const path = new URL("../.env", import.meta.url);
  let content = "";
  try {
    content = await readFile(path, "utf8");
  } catch {
    /* no .env yet */
  }
  for (const [key, value] of Object.entries(vars)) {
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, "m");
    content = re.test(content) ? content.replace(re, line) : content + `\n${line}`;
  }
  await writeFile(path, content.trimEnd() + "\n");
}

main().catch((err) => {
  console.error("setup-notion failed:", err);
  process.exit(1);
});
