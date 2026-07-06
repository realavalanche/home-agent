import { config } from "../config.js";

const GRAPH = `https://graph.facebook.com/${config.WHATSAPP_GRAPH_VERSION}`;

export interface MediaBytes {
  buffer: Buffer;
  mimeType: string;
}

/**
 * Download inbound media (a voice note) by its media id. Two-step per Meta's
 * API: resolve the media id to a short-lived URL, then GET the bytes with the
 * bearer token. We return the bytes in-memory and never persist audio to disk
 * (requirement: store transcripts only).
 */
export async function downloadMedia(mediaId: string): Promise<MediaBytes> {
  const metaRes = await fetch(`${GRAPH}/${mediaId}`, {
    headers: { Authorization: `Bearer ${config.WHATSAPP_ACCESS_TOKEN}` },
  });
  if (!metaRes.ok) {
    throw new Error(`media lookup failed: ${metaRes.status} ${await metaRes.text()}`);
  }
  const meta = (await metaRes.json()) as { url: string; mime_type: string };

  const binRes = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${config.WHATSAPP_ACCESS_TOKEN}` },
  });
  if (!binRes.ok) {
    throw new Error(`media download failed: ${binRes.status}`);
  }
  const buffer = Buffer.from(await binRes.arrayBuffer());
  return { buffer, mimeType: meta.mime_type };
}
