import type { Message, Space } from "spectrum-ts";

import { run } from "./agent.ts";
import { isDuplicate } from "./archive/dedupe.ts";
import { archiveInbound, rememberSpace, sendAndArchive } from "./archive/send.ts";
import { forget } from "./history.ts";
import { joloAgent, type AgentClient } from "./jolo/agent-client.ts";
import { handleJolo, type JoloContext, joloState } from "./jolo/conversation.ts";
import { linkOwnerCafe, type LinkedCafe } from "./jolo/link-cafe.ts";
import { recordCustomerAsk } from "./jolo/customer-asks.ts";
import { llmEnabled, LlmError } from "./llm.ts";

const SIGNAL_CONTENT: ReadonlySet<string> = new Set([
  "read",
  "typing",
  "unsend",
  "edit",
]);

const COMMANDS: ReadonlySet<string> = new Set(["/ping", "/whoami", "/help", "/reset"]);

export type InboundSource = "stream" | "webhook";

export interface RespondOptions {
  /** The JOLO agent. Defaults to the one AGENT_URL configures; undefined = JOLO flow off. */
  agent?: AgentClient;
  /** Writes the owner's café. Defaults to the Firestore emulator. */
  linkOwner?: (profile: LinkedCafe) => Promise<void>;
  /** Saves a customer's question for the app. */
  recordAsk?: (phone: string, text: string) => Promise<void>;
  /** Saves a customer's review for the app. */
  saveReview?: JoloContext["saveReview"];
  /** How long after a café is looked at to ask for a review. */
  reviewDelayMs?: number;
}

// Shared by both inbound paths. `app.webhook()` is stateless and does not feed
// `app.messages`, so the stream loop and the webhook handler would otherwise
// drift apart. `source` only labels the archive row.
export async function respond(
  space: Space,
  message: Message,
  source: InboundSource = "stream",
  options: RespondOptions = {},
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

  const agent = "agent" in options ? options.agent : joloAgent;
  const who = message.sender?.id ?? "unknown";
  const say = async (text: string) => {
    await sendAndArchive(space, text, "agent");
  };

  const text = message.content.type === "text" ? message.content.text.trim() : "";
  console.log(`[${message.platform}] ${who}: ${text || `<${message.content.type}>`}`);

  // `responding` shows a typing indicator and clears it even if the body throws.
  if (COMMANDS.has(text)) {
    await space.responding(() => command(text, space, message, who, Boolean(agent), say));
    return;
  }

  // JOLO flow (AGENT_URL set): onboarding, then Bhavesh's agent. Photos too.
  if (agent) {
    await space.responding(() =>
      handleJolo({
        space,
        message,
        agent,
        say,
        linkOwner: options.linkOwner ?? linkOwnerCafe,
        recordAsk: options.recordAsk ?? recordCustomerAsk,
        ...(options.saveReview ? { saveReview: options.saveReview } : {}),
        ...(options.reviewDelayMs !== undefined ? { reviewDelayMs: options.reviewDelayMs } : {}),
      }),
    );
    return;
  }

  if (message.content.type !== "text") {
    await say(`Received a ${message.content.type} message.`);
    return;
  }

  await space.responding(async () => {
    await say(await answer(space, message, text));
  });
}

async function command(
  text: string,
  space: Space,
  message: Message,
  who: string,
  joloOn: boolean,
  say: (text: string) => Promise<void>,
): Promise<void> {
  switch (text) {
    case "/ping":
      await say("pong");
      return;
    case "/whoami": {
      const jolo = joloOn ? joloState(space.id) : undefined;
      await say(
        [
          `platform: ${message.platform}`,
          `sender:   ${who}`,
          `message:  ${message.id}`,
          ...(jolo ? [`name:     ${jolo.name ?? "(not asked yet)"}`, `role:     ${jolo.role ?? "(not asked yet)"}`] : []),
        ].join("\n"),
      );
      return;
    }
    case "/help":
      await say(
        [
          joloOn
            ? "JOLO keeps café menus up to date. Owners text a photo of their menu; customers ask what's on it."
            : llmEnabled
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
  }
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
