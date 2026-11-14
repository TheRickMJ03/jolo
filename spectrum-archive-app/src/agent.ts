import { llmMaxSteps } from "./env.ts";
import { lengthOf, promptFor, remember } from "./history.ts";
import { chat, LlmError } from "./llm.ts";
import { runTool, type ToolContext } from "./tools/index.ts";

export interface AgentContext {
  spaceId: string;
  platform: string;
  senderId: string;
  /** Lets a tool message the conversation later, after the turn has ended. */
  send(text: string): Promise<void>;
}

/**
 * One turn of the agent loop: ask the model, run whatever tools it asks for,
 * feed the results back, and repeat until it answers in words.
 */
export async function run(text: string, ctx: AgentContext): Promise<string> {
  const { spaceId } = ctx;
  remember(spaceId, { role: "user", content: text });

  for (let step = 0; step < llmMaxSteps; step += 1) {
    const result = await chat(promptFor(spaceId));

    // Replay the assistant turn verbatim, tool calls included: the tool
    // results below are only valid as answers to these exact call ids.
    remember(spaceId, {
      role: "assistant",
      content: result.text,
      ...(result.toolCalls.length > 0 ? { tool_calls: result.toolCalls } : {}),
    });

    if (result.toolCalls.length === 0) {
      if (result.text) return result.text;
      throw new LlmError("model stopped without an answer");
    }

    const toolContext: ToolContext = { ...ctx, historyLength: lengthOf(spaceId) };

    // Calls in one turn are independent, so run them together.
    const results = await Promise.all(
      result.toolCalls.map(async (call) => ({
        id: call.id,
        name: call.function.name,
        output: await runTool(call.function.name, call.function.arguments, toolContext),
      })),
    );

    for (const { id, name, output } of results) {
      console.log(`[tool] ${name} -> ${output.slice(0, 120)}`);
      remember(spaceId, { role: "tool", tool_call_id: id, content: output });
    }
  }

  // Out of steps. Without this the loop could run until the free tier says no.
  throw new LlmError(
    `gave up after ${llmMaxSteps} tool-calling steps without a final answer`,
  );
}
