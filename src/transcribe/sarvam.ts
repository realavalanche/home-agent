import { config } from "../config.js";
import type { MediaBytes } from "../whatsapp/media.js";

export interface Transcription {
  text: string;
  languageCode: string; // BCP-47, e.g. hi-IN, en-IN; used to reply in kind
}

const SARVAM_STT_URL = "https://api.sarvam.ai/speech-to-text";

/**
 * Transcribe a voice note with Sarvam. Chosen over Whisper because it is trained
 * on Indian audio and keeps accuracy across mid-sentence Hindi↔English switching,
 * and it returns a detected language_code we use for same-language replies.
 *
 * language_code="unknown" lets Sarvam auto-detect (incl. code-mixed speech).
 * Audio bytes are passed in memory and never written to disk.
 */
export async function transcribe(media: MediaBytes): Promise<Transcription> {
  const form = new FormData();
  const ext = extensionFor(media.mimeType);
  form.append("file", new Blob([new Uint8Array(media.buffer)], { type: media.mimeType }), `audio.${ext}`);
  form.append("model", config.SARVAM_STT_MODEL);
  form.append("language_code", "unknown");

  const res = await fetch(SARVAM_STT_URL, {
    method: "POST",
    headers: { "api-subscription-key": config.SARVAM_API_KEY },
    body: form,
  });
  if (!res.ok) {
    throw new Error(`sarvam STT failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { transcript?: string; language_code?: string };
  return {
    text: (json.transcript ?? "").trim(),
    languageCode: json.language_code ?? "en-IN",
  };
}

function extensionFor(mime: string): string {
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  if (mime.includes("mp4") || mime.includes("m4a")) return "m4a";
  if (mime.includes("wav")) return "wav";
  if (mime.includes("amr")) return "amr";
  return "ogg";
}
