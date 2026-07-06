import { VoyageAIClient } from "voyageai";
import { config } from "../config.js";

/**
 * Multilingual embeddings via Voyage. voyage-3 handles Hinglish/Hindi notes far
 * better than English-only embedders, which matters because captures are often
 * code-mixed. Dimension is 1024 (matches the vector column in schema.sql).
 */
const client = new VoyageAIClient({ apiKey: config.VOYAGE_API_KEY });

export async function embed(
  textInput: string,
  inputType: "document" | "query" = "document"
): Promise<number[]> {
  const res = await client.embed({
    model: config.VOYAGE_MODEL,
    input: [textInput],
    inputType,
  });
  const vec = res.data?.[0]?.embedding;
  if (!vec) throw new Error("voyage returned no embedding");
  return vec;
}
