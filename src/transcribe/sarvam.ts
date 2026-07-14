import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { MediaBytes } from "../whatsapp/media.js";

export interface Transcription {
  text: string;
  languageCode: string; // BCP-47, e.g. hi-IN, en-IN; used to reply in kind
}

const SARVAM_STT_URL = "https://api.sarvam.ai/speech-to-text";

/**
 * Sarvam's REST transcription endpoint accepts a maximum of 30 SECONDS of audio.
 * Longer voice notes were being rejected outright — so we split anything longer
 * into segments, transcribe each, and stitch the text back together.
 */
const SEGMENT_SECONDS = 25; // safely under Sarvam's 30s ceiling

/**
 * Transcribe a voice note with Sarvam. Chosen over Whisper because it is trained
 * on Indian audio and keeps accuracy across mid-sentence Hindi↔English switching,
 * and it returns a detected language_code we use for same-language replies.
 *
 * Audio is only ever written to an ephemeral temp dir for segmenting, and that
 * dir is always removed — no raw audio is retained.
 */
export async function transcribe(media: MediaBytes): Promise<Transcription> {
  const chunks = await splitAudio(media);

  // Short note (the common case) → one call, no segmenting overhead.
  if (chunks.length === 1) {
    return transcribeOne(chunks[0]!, media.mimeType);
  }

  logger.info("long voice note — transcribing in segments", { segments: chunks.length });
  const parts: Transcription[] = [];
  for (const chunk of chunks) {
    parts.push(await transcribeOne(chunk, media.mimeType));
  }
  return {
    text: parts.map((p) => p.text).filter(Boolean).join(" ").trim(),
    // Language of the first segment that detected one.
    languageCode: parts.find((p) => p.languageCode)?.languageCode ?? "en-IN",
  };
}

/** One Sarvam REST call for a single (≤30s) piece of audio. */
async function transcribeOne(buffer: Buffer, mimeType: string): Promise<Transcription> {
  const form = new FormData();
  const ext = extensionFor(mimeType);
  form.append("file", new Blob([new Uint8Array(buffer)], { type: mimeType }), `audio.${ext}`);
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

/**
 * Split audio into ≤SEGMENT_SECONDS pieces using ffmpeg (stream copy, so it's
 * fast and lossless). Returns a single-element array for short clips. If ffmpeg
 * is unavailable, we fall back to the original buffer so short notes still work.
 */
async function splitAudio(media: MediaBytes): Promise<Buffer[]> {
  const ext = extensionFor(media.mimeType);
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), "ha-audio-"));
    const input = join(dir, `in.${ext}`);
    await writeFile(input, media.buffer);

    await runFfmpeg([
      "-hide_banner",
      "-loglevel", "error",
      "-i", input,
      "-f", "segment",
      "-segment_time", String(SEGMENT_SECONDS),
      "-c", "copy",
      join(dir, `out_%03d.${ext}`),
    ]);

    const files = (await readdir(dir)).filter((f) => f.startsWith("out_")).sort();
    if (!files.length) return [media.buffer];
    return await Promise.all(files.map((f) => readFile(join(dir!, f))));
  } catch (err) {
    logger.warn("audio segmenting failed; using original buffer", { err: String(err) });
    return [media.buffer];
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args);
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += String(d)));
    proc.on("error", reject); // e.g. ffmpeg not installed
    proc.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(0, 300)}`))
    );
  });
}

function extensionFor(mime: string): string {
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  if (mime.includes("mp4") || mime.includes("m4a")) return "m4a";
  if (mime.includes("wav")) return "wav";
  if (mime.includes("amr")) return "amr";
  return "ogg";
}
