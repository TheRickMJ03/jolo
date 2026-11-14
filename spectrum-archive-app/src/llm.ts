import { llmApiKey, llmBaseUrl, llmModel, llmTimeoutMs } from "./env.ts";
import { toolSchemas } from "./tools/index.ts";

export interface RawToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

// Mirrors the OpenAI-compatible message shapes. Assistant messages carrying
// tool calls and the tool results that answer them are replayed verbatim, so
// the model sees what it asked for and what came back.
export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: RawToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ChatResult {
  text: string | null;
  toolCalls: RawToolCall[];
}

// Written against the OpenAI-compatible chat-completions shape, which Ollama
// serves at /v1 alongside its native API. Groq, OpenRouter, Cerebras and
// others speak the same shape, so switching is LLM_BASE_URL + LLM_MODEL.
interface ChatCompletionResponse {
  choices?: {
    message?: { content?: string | null; tool_calls?: RawToolCall[] };
  }[];
  error?: { message?: string };
}

export const llmEnabled = Boolean(llmModel);

export class LlmError extends Error {}

export async function chat(messages: ChatMessage[]): Promise<ChatResult> {
  if (!llmModel) throw new LlmError("no LLM_MODEL configured");

  // CPU inference is slow enough that the default fetch behaviour (wait
  // forever) would wedge the message loop on a bad day.
  const signal = AbortSignal.timeout(llmTimeoutMs);

  let response: Response;
  try {
    response = await fetch(`${llmBaseUrl}/chat/completions`, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        // Ollama ignores the key; hosted providers require it.
        ...(llmApiKey ? { authorization: `Bearer ${llmApiKey}` } : {}),
      },
      body: JSON.stringify({
        model: llmModel,
        messages,
        stream: false,
        tools: toolSchemas,
      }),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new LlmError(`model did not answer within ${llmTimeoutMs}ms`);
    }
    throw new LlmError(
      `cannot reach ${llmBaseUrl} — is the server running? (${String(error)})`,
    );
  }

  if (!response.ok) {
    throw new LlmError(
      `${llmBaseUrl} returned ${response.status}: ${(await response.text()).slice(0, 200)}`,
    );
  }

  const body = (await response.json()) as ChatCompletionResponse;
  if (body.error?.message) throw new LlmError(body.error.message);

  const message = body.choices?.[0]?.message;
  const text = message?.content?.trim() || null;
  const toolCalls = message?.tool_calls ?? [];

  // A turn with neither text nor a tool call is a dead end — surface it rather
  // than sending the user an empty message.
  if (!text && toolCalls.length === 0) {
    throw new LlmError("model returned an empty response");
  }

  return { text, toolCalls };
}
