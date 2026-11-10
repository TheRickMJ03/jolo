import type { Message, Space } from "spectrum-ts";

import { run } from "./agent.ts";
import { isDuplicate } from "./archive/dedupe.ts";
import { archiveInbound, rememberSpace, sendAndArchive } from "./archive/send.ts";
import { forget } from "./history.ts";
import { llmEnabled, LlmError } from "./llm.ts";

const SIGNAL_CONTENT: ReadonlySet<string> = new Set([
  "read",
  "typing",
  "unsend",
  "edit",
]);

export type InboundSource = "stream" | "webhook";

// Shared by both inbound paths. `app.webhook()` is stateless and does not feed
// `app.messages`, so the stream loop and the webhook handler would otherwise
// drift apart. `source` only labels the archive row.
export async function respond(
  space: Space,
  message: Message,
  source: InboundSource = "stream",
): Promise<void> {
  // Providers echo back what we send; skip it so the app never talks to itself.
  // Not archived either: our own sends are archived where we send them.
  if (message.direction === "outbound") return;

  // Signals, not user content. Never reply to these: a reply gets marked read,
  // the read receipt arrives here as another `read` message, and answering it
  // sends another reply. That loops forever. Not archived.
  if (SIGNAL_CONTENT.has(message.content.type)) return;

  // Deliveries are at-least-once. A redelivered id is neither archived nor
  // answered a second time.
  if (isDuplicate(message.platform, message.id)) {
    console.log(`[dedupe] skipped repeat delivery of ${message.platform} message ${message.id}`);
    return;
  }

  rememberSpace(space);
  archiveInbound(space, message, source);

  const who = message.sender?.id ?? "unknown";
  const say = async (text: string) => {
    await sendAndArchive(space, text, "agent");
  };

  if (message.content.type !== "text") {
    console.log(`[${message.platform}] ${who}: <${message.content.type}>`);
    await say(`Received a ${message.content.type} message.`);
    return;
  }

  const text = message.content.text.trim();
  console.log(`[${message.platform}] ${who}: ${text}`);

  // `responding` shows a typing indicator and clears it even if the body throws.
  await space.responding(async () => {
    switch (text) {
      case "/ping":
        await say("pong");
        return;
      case "/whoami":
        await say(
          [
            `platform: ${message.platform}`,
            `sender:   ${who}`,
            `message:  ${message.id}`,
          ].join("\n"),
        );
        return;
      case "/help":
        await say(
          [
            llmEnabled
              ? "Spectrum archive app, backed by a model."
              : "Spectrum archive app. Anything you send comes back prefixed with echo:.",
            "Every message is archived as Parquet.",
            "/ping    — check the agent is alive",
            "/whoami  — print sender and platform details",
            "/reset   — forget this conversation (the archive is kept)",
            "/help    — this message",
          ].join("\n"),
        );
        return;
      case "/reset":
        forget(space.id);
        await say("Forgotten — messages and saved notes.");
        return;
      default:
        await say(await answer(space, message, text));
    }
  });
}

/** The webhook's handler: respond(), labelled as a webhook delivery. */
export const respondFromWebhook = (space: Space, message: Message) =>
  respond(space, message, "webhook");

// Falls back to echoing when no model is configured, so the app still works as
// a transport test on its own.
async function answer(space: Space, message: Message, text: string): Promise<string> {
  if (!llmEnabled) return `echo: ${text}`;

  try {
    return await run(text, {
      spaceId: message.space.id,
      platform: message.platform,
      senderId: message.sender?.id ?? "unknown",
      send: async (reply) => {
        await sendAndArchive(space, reply, "agent");
      },
    });
  } catch (error) {
    if (error instanceof LlmError) {
      console.error(`[llm] ${error.message}`);
      return `The model did not answer: ${error.message}`;
    }
    throw error;
  }
}
