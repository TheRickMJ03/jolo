// `npm run agent:stub` — a local stand-in for Bhavesh's agent (see
// src/jolo/stub-agent.ts). Point the bridge at it with AGENT_URL.
//
//   STUB_PORT=8788                       where it listens
//   STUB_OWNER_HANDLES=terminal-user     comma-separated handles that own "Barbara's"
//                                        (your iMessage number, e.g. +19085551234)
//   AGENT_TOKEN=                         if set, required as a bearer token
import { agentToken } from "../src/env.ts";
import { createStubAgent } from "../src/jolo/stub-agent.ts";

const port = Number(process.env.STUB_PORT ?? 8788);
const ownerHandles = (process.env.STUB_OWNER_HANDLES ?? "terminal-user")
  .split(",")
  .map((handle) => handle.trim())
  .filter(Boolean);

createStubAgent({ ownerHandles, token: agentToken }).listen(port, "127.0.0.1", () => {
  console.log(`[stub-agent] STAND-IN agent on http://127.0.0.1:${port}/v1/turn — not the real one.`);
  console.log(`[stub-agent] owners of "Barbara's": ${ownerHandles.join(", ")}`);
  console.log(`[stub-agent] run the bridge with AGENT_URL=http://127.0.0.1:${port}`);
});
