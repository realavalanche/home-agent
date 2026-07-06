import { google } from "googleapis";
import { getAuthedClient } from "./auth.js";
import type { AuthorKey } from "../users.js";

/**
 * Gmail: search/read + draft only. We deliberately never call messages.send —
 * the agent can prepare a draft in the user's Gmail for them to review and send.
 */

async function gmailFor(authorKey: AuthorKey) {
  const auth = await getAuthedClient(authorKey);
  if (!auth) return undefined;
  return google.gmail({ version: "v1", auth });
}

export interface EmailHit {
  id: string;
  from: string;
  subject: string;
  snippet: string;
  date: string;
}

/** Search the user's mailbox with a Gmail query, returning summarized hits. */
export async function searchEmail(authorKey: AuthorKey, q: string, max = 5): Promise<EmailHit[]> {
  const gmail = await gmailFor(authorKey);
  if (!gmail) return [];
  const list = await gmail.users.messages.list({ userId: "me", q, maxResults: max });
  const ids = (list.data.messages ?? []).map((m) => m.id!).filter(Boolean);
  const hits: EmailHit[] = [];
  for (const id of ids) {
    const msg = await gmail.users.messages.get({
      userId: "me",
      id,
      format: "metadata",
      metadataHeaders: ["From", "Subject", "Date"],
    });
    const headers = msg.data.payload?.headers ?? [];
    const h = (name: string) => headers.find((x) => x.name === name)?.value ?? "";
    hits.push({
      id,
      from: h("From"),
      subject: h("Subject"),
      snippet: msg.data.snippet ?? "",
      date: h("Date"),
    });
  }
  return hits;
}

/** Create a draft (never sent) in the user's Gmail. Returns the draft id. */
export async function createDraft(
  authorKey: AuthorKey,
  to: string,
  subject: string,
  body: string
): Promise<{ ok: boolean; draftId?: string; error?: string }> {
  const gmail = await gmailFor(authorKey);
  if (!gmail) return { ok: false, error: "not_connected" };
  const raw = Buffer.from(
    `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${body}`
  )
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const res = await gmail.users.drafts.create({ userId: "me", requestBody: { message: { raw } } });
  return { ok: true, draftId: res.data.id ?? undefined };
}
