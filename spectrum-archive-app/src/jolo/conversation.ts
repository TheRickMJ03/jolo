// The JOLO conversation (docs/conversation-design.md): onboarding first, then
// every message goes to the agent, whose actions are rendered with the copy in
// copy.ts. The bridge owns the wording and the "which question is pending"
// state; the agent owns menus and Firestore.
import type { Message, Space } from "spectrum-ts";

import { getRecord, touch } from "../store.ts";
import { AgentError, type AgentClient } from "./agent-client.ts";
import { type CollectedContent, collectContent, MAX_PHOTOS } from "./content.ts";
import { confirmSummary, copy } from "./copy.ts";
import { parseConfirm, parseName, parseRole, parseScope } from "./parse.ts";
import type { AgentAction, JoloState, TurnEvent } from "./types.ts";

export interface JoloContext {
  space: Space;
  message: Message;
  agent: AgentClient;
  /** Sends one message into the conversation (and archives it). */
  say(text: string): Promise<void>;
}

export function joloState(spaceId: string): JoloState {
  const record = getRecord(spaceId);
  record.jolo ??= {};
  return record.jolo;
}

export async function handleJolo(ctx: JoloContext): Promise<void> {
  const { space, say } = ctx;
  const state = joloState(space.id);
  const content = await collectContent(ctx.message);

  try {
    if (!state.role) {
      await onboard(state, content, say);
      return;
    }

    const hasPhotos = content.photos.length > 0;

    // A pending question is answered by text. A new photo starts over instead.
    if (state.pending && !hasPhotos) {
      const event = answerEvent(state.pending, content.text);
      if (!event) {
        await say(state.pending === "scope" ? copy.askScopeAgain : copy.confirmAgain);
        return;
      }
      await callAgent(ctx, state, event);
      return;
    }

    if (content.tooLarge) await say(copy.photoTooLarge);
    if (content.tooManyPhotos) await say(copy.tooManyPhotos(MAX_PHOTOS));
    if (!hasPhotos && !content.text) {
      if (content.unsupported) await say(copy.unsupported);
      return;
    }

    await callAgent(ctx, state, { type: "message", text: content.text, photos: content.photos });
  } finally {
    touch(space.id);
  }
}

function answerEvent(pending: "scope" | "confirm", text: string): TurnEvent | null {
  if (pending === "scope") {
    const scope = parseScope(text);
    return scope ? { type: "scope", scope } : null;
  }
  const confirmed = parseConfirm(text);
  return confirmed === null ? null : { type: "confirm", confirmed };
}

async function onboard(
  state: JoloState,
  content: CollectedContent,
  say: (text: string) => Promise<void>,
): Promise<void> {
  if (content.photos.length > 0 || content.tooLarge) state.heldPhoto = true;

  if (!state.onboarding) {
    state.onboarding = "name";
    await say(copy.greeting);
    return;
  }

  if (state.onboarding === "name") {
    const name = parseName(content.text);
    if (!name) {
      await say(copy.askNameAgain);
      return;
    }
    state.name = name;
    state.onboarding = "role";
    await say(copy.askRole(name));
    return;
  }

  const role = parseRole(content.text);
  if (!role) {
    await say(copy.askRoleAgain);
    return;
  }
  state.role = role;
  delete state.onboarding;
  await say(copy.welcome(role));
  if (state.heldPhoto) {
    delete state.heldPhoto;
    await say(copy.resendPhoto);
  }
}

async function callAgent(ctx: JoloContext, state: JoloState, event: TurnEvent): Promise<void> {
  let actions: AgentAction[];
  try {
    actions = await ctx.agent.turn({
      conversation_id: ctx.space.id,
      platform: ctx.message.platform,
      sender: {
        // From the transport — never from what the person typed. The agent
        // decides ownership on this handle alone (docs/contracts.md §2).
        handle: ctx.message.sender?.id ?? "unknown",
        name: state.name ?? null,
        role: state.role ?? null,
      },
      event,
    });
  } catch (error) {
    if (!(error instanceof AgentError)) throw error;
    console.error(`[jolo] ${error.message}`);
    // Pending question kept: the owner can simply answer again.
    await ctx.say(copy.agentDown);
    return;
  }

  // The agent answered, so whatever was pending has been dealt with; any new
  // question comes from the actions below.
  delete state.pending;
  for (const action of actions) await render(action, state, ctx.say);
}

async function render(
  action: AgentAction,
  state: JoloState,
  say: (text: string) => Promise<void>,
): Promise<void> {
  switch (action.type) {
    case "say":
      await say(action.text);
      return;
    case "ask_scope":
      state.pending = "scope";
      await say(copy.askScope);
      return;
    case "confirm_changes": {
      const summary = confirmSummary(action.changes);
      if (!summary) {
        await say(copy.noChanges);
        return;
      }
      state.pending = "confirm";
      await say(summary);
      return;
    }
    case "menu_updated":
      await say(copy.menuUpdated);
      return;
    case "cancelled":
      await say(copy.cancelled);
      return;
    case "not_owner":
      await say(copy.notOwner);
      return;
  }
}
