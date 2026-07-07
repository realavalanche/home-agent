import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import type { MediaBytes } from "./whatsapp/media.js";

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

/**
 * Turn an image or PDF into a concise text extraction the rest of the pipeline
 * can treat like a transcript: what it is, plus any useful details (amounts,
 * dates, names, items, dosages). Claude vision handles both photos and PDFs.
 * Returns undefined for unsupported types.
 */
export async function describeMedia(
  media: MediaBytes,
  caption?: string
): Promise<string | undefined> {
  const data = media.buffer.toString("base64");
  let block: Anthropic.ContentBlockParam;

  if (IMAGE_TYPES.includes(media.mimeType)) {
    block = {
      type: "image",
      source: { type: "base64", media_type: media.mimeType as never, data },
    };
  } else if (media.mimeType.includes("pdf")) {
    block = {
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data },
    };
  } else {
    return undefined;
  }

  const res = await anthropic.messages.create({
    model: config.CLAUDE_AGENT_MODEL,
    max_tokens: 600,
    messages: [
      {
        role: "user",
        content: [
          block,
          {
            type: "text",
            text: `Extract this into a short, useful note for a personal assistant.${
              caption ? ` The sender's caption: "${caption}".` : ""
            } Say what it is and capture key details (amounts, dates, names, items, dosages, actions). 2-4 lines, no preamble.`,
          },
        ],
      },
    ],
  });

  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}
