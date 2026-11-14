import "./setup.ts";

import assert from "node:assert/strict";
import { test } from "node:test";

import { trim } from "../src/history.ts";
import type { ChatMessage, RawToolCall } from "../src/llm.ts";

const call = (id: string): RawToolCall => ({
  id,
  type: "function",
  function: { name: "get_current_time", arguments: "{}" },
});

// Two exchanges with tool calls, one of them multi-step with parallel calls.
const transcript: ChatMessage[] = [
  { role: "user", content: "what time is it, and 2+2?" },
  { role: "assistant", content: null, tool_calls: [call("a"), call("b")] },
  { role: "tool", tool_call_id: "a", content: "noon" },
  { role: "tool", tool_call_id: "b", content: "4" },
  { role: "assistant", content: "Noon, and 4." },
  { role: "user", content: "and in Tokyo?" },
  { role: "assistant", content: null, tool_calls: [call("c")] },
  { role: "tool", tool_call_id: "c", content: "2am" },
  { role: "assistant", content: null, tool_calls: [call("d"), call("e")] },
  { role: "tool", tool_call_id: "d", content: "Thursday" },
  { role: "tool", tool_call_id: "e", content: "JST" },
  { role: "assistant", content: "2am Thursday, JST." },
];

/** Every tool result must have its assistant call earlier in the same slice. */
function assertNoOrphans(turns: ChatMessage[]): void {
  const called = new Set<string>();
  for (const message of turns) {
    if (message.role === "assistant") for (const c of message.tool_calls ?? []) called.add(c.id);
    if (message.role === "tool") {
      assert.ok(called.has(message.tool_call_id), `tool result ${message.tool_call_id} lost its call`);
    }
  }
}

test("trim never splits an assistant tool call from its results, at any cap", () => {
  for (let max = 1; max <= transcript.length + 1; max += 1) {
    const kept = trim(transcript, max);
    assert.ok(kept.length > 0, `max=${max} kept nothing`);
    assertNoOrphans(kept);
    // Always a suffix of the original.
    assert.deepEqual(kept, transcript.slice(transcript.length - kept.length));
    // Starts at a user turn whenever anything was dropped.
    if (kept.length < transcript.length) assert.equal(kept[0]?.role, "user", `max=${max}`);
  }
});

test("trim keeps everything under the cap and rewinds to a user message over it", () => {
  assert.equal(trim(transcript, 100), transcript);
  assert.deepEqual(trim(transcript, 7), transcript.slice(5));
});

test("mid-exchange as the transcript grows one message at a time (as remember() does)", () => {
  let turns: ChatMessage[] = [];
  for (const message of transcript) {
    turns = trim([...turns, message], 3);
    assertNoOrphans(turns);
  }
});
