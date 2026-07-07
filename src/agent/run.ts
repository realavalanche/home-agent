import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { buildSystemPrompt } from "./prompts.js";
import { TOOLS, runTool, type AgentContext } from "./tools.js";
import { latestPendingConfirmation } from "../scheduler/schedule.js";
import { loadRecentTurns, saveTurns } from "../memory.js";

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

const MAX_TURNS = 6;

/**
 * Run the agent over one inbound message. Returns the final reply text (already
 * in the user's language). Tools do the side effects (Notion, calendar, etc.).
 */
export async function runAgent(ctx: AgentContext): Promise<string> {
  const pending = await latestPendingConfirmation(ctx.user.key);
  const pendingDesc = pending
    ? `to ${pending.recipient} at ${new Date(pending.send_at).toISOString()}: "${pending.body}"`
    : undefined;

  const system = buildSystemPrompt(ctx.user, pendingDesc);

  // Replay recent conversation turns so the agent can follow a multi-message
  // thread, then add the new message.
  const history = await loadRecentTurns(ctx.user.key);
  const messages: Anthropic.MessageParam[] = [
    ...history.map((t) => ({ role: t.role, content: t.content }) as Anthropic.MessageParam),
    { role: "user", content: ctx.transcript },
  ];

  const reply = await runLoop(ctx, system, messages);

  // Persist this exchange as the newest turns (best-effort).
  await saveTurns(ctx.user.key, ctx.transcript, reply).catch(() => {});
  return reply;
}

/** The tool-using loop. Returns the final reply text. */
async function runLoop(
  ctx: AgentContext,
  system: string,
  messages: Anthropic.MessageParam[]
): Promise<string> {
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const res = await anthropic.messages.create({
      model: config.CLAUDE_AGENT_MODEL,
      max_tokens: 1024,
      system,
      tools: TOOLS,
      messages,
    });

    messages.push({ role: "assistant", content: res.content });

    if (res.stop_reason !== "tool_use") {
      return extractText(res.content) || defaultAck(ctx);
    }

    // Execute every tool_use block and feed results back.
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of res.content) {
      if (block.type === "tool_use") {
        const output = await runTool(block.name, block.input as Record<string, unknown>, ctx);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: output,
        });
      }
    }
    messages.push({ role: "user", content: toolResults });
  }

  logger.warn("agent hit max turns", { waMessageId: ctx.waMessageId });
  return defaultAck(ctx);
}

function extractText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function defaultAck(ctx: AgentContext): string {
  return ctx.language.startsWith("hi") ? "Ho gaya ✅" : "Done ✅";
}
