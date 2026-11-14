import { llmHistoryTurns, llmSystemPrompt } from "./env.ts";
import type { ChatMessage } from "./llm.ts";
import { dropSpace, getRecord, touch } from "./store.ts";

export function remember(spaceId: string, message: ChatMessage): void {
  const record = getRecord(spaceId);
  record.transcript.push(message);
  record.transcript = trim(record.transcript);
  touch(spaceId);
}

// The API is stateless, so every message kept is resent and paid for on each
// call. Trimming is not just dropping the front, though: a `tool` result is
// only valid directly after the assistant message whose tool call it answers,
// so cutting between the two would make the next request malformed. Drop whole
// exchanges by rewinding to a user message.
export function trim(turns: ChatMessage[], max: number = llmHistoryTurns): ChatMessage[] {
  if (turns.length <= max) return turns;

  let start = turns.length - max;
  while (start < turns.length && turns[start]?.role !== "user") start += 1;
  if (start < turns.length) return turns.slice(start);

  // No user message inside the window: one exchange (a user turn plus many
  // tool steps) is longer than `max`. The guide's version kept only the last
  // message here, which can be a lone `tool` result with its assistant call
  // cut away — exactly the malformed request this function exists to prevent.
  // Keep the whole current exchange instead; LLM_MAX_STEPS bounds its length.
  let lastUser = turns.length - max - 1;
  while (lastUser >= 0 && turns[lastUser]?.role !== "user") lastUser -= 1;
  return lastUser >= 0 ? turns.slice(lastUser) : turns;
}

export function promptFor(spaceId: string): ChatMessage[] {
  return [
    { role: "system", content: llmSystemPrompt },
    ...getRecord(spaceId).transcript,
  ];
}

export function lengthOf(spaceId: string): number {
  return getRecord(spaceId).transcript.length;
}

/** Clears this conversation entirely — transcript and notes alike. */
export function forget(spaceId: string): void {
  dropSpace(spaceId);
}
