// The JOLO conversation (docs/conversation-design.md): onboarding first, then
// every message goes to the agent, whose actions are rendered with the copy in
// copy.ts. The bridge owns the wording and the "which question is pending"
// state; the agent owns menus and Firestore.
import type { Message, Space } from "spectrum-ts";

import { getRecord, touch } from "../store.ts";
import { AgentError, type AgentClient } from "./agent-client.ts";
import { type CollectedContent, collectContent, MAX_PHOTOS } from "./content.ts";
import { confirmSummary, copy } from "./copy.ts";
import { linkOwnerCafe, toE164, type LinkedCafe } from "./link-cafe.ts";
import { parseConfirmReply, parseOwnerProfile, parseRole, parseScope } from "./parse.ts";
import type { AgentAction, JoloState, TurnEvent } from "./types.ts";

export interface JoloContext {
  space: Space;
  message: Message;
  agent: AgentClient;
  /** Sends one message into the conversation (and archives it). */
  say(text: string): Promise<void>;
  /** Writes the café the app shows for this phone. Tests pass their own. */
  linkOwner?: (profile: LinkedCafe) => Promise<void>;
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
      await onboard(state, content, say, ctx.message.sender?.id ?? "", ctx.linkOwner ?? linkOwnerCafe);
      return;
    }

    const hasPhotos = content.photos.length > 0;

    // A pending question is answered by text. A photo sent meanwhile is another
    // part of the same menu: it goes to the agent, which merges it in.
    if (state.pending && !hasPhotos) {
      // A voice note or a file isn't an answer; say so instead of re-asking the question.
      if (!content.text && content.unsupported) {
        await say(copy.unsupported);
        return;
      }
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

    if (hasPhotos) {
      // A read takes 15 to 100 seconds, so say so before starting it.
      await say(state.updating ? copy.readingMore : copy.reading);
      state.updating = true;
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
  const reply = parseConfirmReply(text);
  if (reply === null) return null;
  return reply === "correction" ? { type: "correction", text: text.trim() } : { type: "confirm", confirmed: reply };
}

async function onboard(
  state: JoloState,
  content: CollectedContent,
  say: (text: string) => Promise<void>,
  handle: string,
  linkOwner: (profile: LinkedCafe) => Promise<void>,
): Promise<void> {
  if (content.photos.length > 0 || content.tooLarge) state.heldPhoto = true;

  if (!state.onboarding) {
    state.onboarding = "role";
    await say(copy.askRole);
    return;
  }

  if (state.onboarding === "role") {
    const role = parseRole(content.text);
    if (role === "customer") {
      // Customers use the app; nothing is written for them here. A photo they
      // sent first isn't a menu update, so it isn't asked for again.
      state.role = "customer";
      delete state.onboarding;
      delete state.heldPhoto;
      await say(copy.welcomeUser);
      return;
    }
    if (role !== "owner") {
      await say(copy.askRoleAgain);
      return;
    }
    state.onboarding = "details";
    await say(copy.askDetails);
    return;
  }

  const profile = parseOwnerProfile(content.text);
  if (!profile) {
    await say(copy.askDetailsAgain);
    return;
  }
  const phone = toE164(handle);
  if (!phone) {
    await say(copy.needPhone);
    return;
  }
  try {
    await linkOwner({ ...profile, phone });
  } catch (error) {
    console.error(`[jolo] café link failed: ${error instanceof Error ? error.message : error}`);
    await say(copy.linkFailed);
    return;
  }
  state.name = profile.name;
  state.businessName = profile.businessName;
  state.location = profile.location;
  state.role = "owner";
  delete state.onboarding;
  await say(copy.welcomeOwner(profile.name, profile.businessName, profile.location));
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
  // question comes from the actions below. A photo that couldn't be read is
  // the exception: the question the owner was on still stands.
  const wasPending = state.pending;
  delete state.pending;
  for (const action of actions) await render(action, state, ctx.say);
  const failed = actions.some((action) => action.type === "unreadable_photo" || action.type === "reader_down");
  if (failed && !state.pending && wasPending) state.pending = wasPending;
  if (!state.pending) delete state.updating;
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
    case "unreadable_photo":
      await say(copy.unreadablePhoto);
      return;
    case "reader_down":
      await say(copy.readerDown);
      return;
  }
}
