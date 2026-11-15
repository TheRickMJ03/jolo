// The JOLO conversation (docs/conversation-design.md): onboarding first, then
// every message goes to the agent, whose actions are rendered with the copy in
// copy.ts. The bridge owns the wording and the "which question is pending"
// state; the agent owns menus and Firestore.
import type { Message, Space } from "spectrum-ts";

import { getRecord, touch } from "../store.ts";
import { AgentError, type AgentClient } from "./agent-client.ts";
import { type CollectedContent, collectContent, MAX_PHOTOS } from "./content.ts";
import { confirmSummary, copy, entireMenu } from "./copy.ts";
import { linkOwnerCafe, toE164, type LinkedCafe } from "./link-cafe.ts";
import { askFromCustomerMessage, recordCustomerAsk } from "./customer-asks.ts";
import {
  parseConfirm,
  parseConfirmReply,
  parseOwnerProfile,
  parseRole,
  parseScope,
  wantsEntireMenu,
} from "./parse.ts";
import {
  cancelReviewTimer,
  isComment,
  markAsked,
  type NewReview,
  parseRating,
  withoutYes,
  planReview,
  reviewDue,
  saveReview,
  scheduleReviewTimer,
  skipsComment,
} from "./reviews.ts";
import { reviewPromptDelayMs } from "../env.ts";
import type { AgentAction, JoloState, TurnEvent } from "./types.ts";

export interface JoloContext {
  space: Space;
  message: Message;
  agent: AgentClient;
  /** Sends one message into the conversation (and archives it). */
  say(text: string): Promise<void>;
  /** Writes the café the app shows for this phone. Tests pass their own. */
  linkOwner?: (profile: LinkedCafe) => Promise<void>;
  /** Saves a customer's question for For you. Tests pass their own. */
  recordAsk?: (phone: string, text: string) => Promise<void>;
  /** Saves a customer's review to Firestore. Tests pass their own. */
  saveReview?: (review: NewReview) => Promise<void>;
  /** How long after a café is looked at to ask for a review. Defaults to REVIEW_PROMPT_DELAY_MS. */
  reviewDelayMs?: number;
}

export function joloState(spaceId: string): JoloState {
  const record = getRecord(spaceId);
  record.jolo ??= {};
  return record.jolo;
}

export async function handleJolo(ctx: JoloContext): Promise<void> {
  const state = joloState(ctx.space.id);
  const content = await collectContent(ctx.message);
  try {
    await handleTurn(ctx, state, content);
    // A review question whose timer was lost (the bridge restarted) is asked now.
    await askReviewIfDue(ctx, state);
  } finally {
    touch(ctx.space.id);
  }
}

async function handleTurn(ctx: JoloContext, state: JoloState, content: CollectedContent): Promise<void> {
  const { say } = ctx;
  if (!state.role) {
    await onboard(state, content, say, ctx.message.sender?.id ?? "", ctx.linkOwner ?? linkOwnerCafe);
    return;
  }

  const hasPhotos = content.photos.length > 0;

  // A review question under way takes the reply. An answer it can't use goes on as a normal message.
  const reviewOpen = state.review && state.review.stage !== "scheduled";
  if (state.role === "customer" && reviewOpen && !hasPhotos && content.text) {
    if (await answerReview(ctx, state, content.text)) return;
  }

  // A pending question is answered by text. A photo sent meanwhile is another
  // part of the same menu: it goes to the agent, which merges it in.
  if (state.pending && !hasPhotos) {
    // A voice note or a file isn't an answer; say so instead of re-asking the question.
    if (!content.text && content.unsupported) {
      await say(copy.unsupported);
      return;
    }
    // "menu" shows the lines the summary left off. The yes/no question stays open.
    if (state.pending === "confirm" && state.pendingChanges && wantsEntireMenu(content.text)) {
      await say(entireMenu(state.pendingChanges));
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
      // Later texts are saved for For you. A photo they sent first isn't a menu.
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
  const ask = askFromCustomerMessage(
    state.role,
    event.type,
    event.type === "message" ? event.text : "",
    ctx.message.sender?.id ?? "",
  );
  if (ask) {
    try {
      await (ctx.recordAsk ?? recordCustomerAsk)(ask.phone, ask.text);
    } catch (error) {
      console.error(`[jolo] ask not saved: ${error instanceof Error ? error.message : error}`);
    }
  }

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
  const wasChanges = state.pendingChanges;
  delete state.pending;
  delete state.pendingChanges;
  for (const action of actions) {
    if (action.type === "cafe_interest") planReviewQuestion(ctx, state, action.cafe_id, action.cafe_name);
    else await render(action, state, ctx.say);
  }
  const failed = actions.some((action) => action.type === "unreadable_photo" || action.type === "reader_down");
  if (failed && !state.pending && wasPending) {
    state.pending = wasPending;
    if (wasChanges) state.pendingChanges = wasChanges;
  }
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
      state.pendingChanges = action.changes;
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
    case "cafe_interest":
      return;
  }
}

// ---------------------------------------------------------------------------
// Reviews (src/jolo/reviews.ts): "did you go?" → 1–5 → a comment → saved.
// ---------------------------------------------------------------------------

function planReviewQuestion(ctx: JoloContext, state: JoloState, cafeId: string, cafeName: string): void {
  const planned = planReview(state, { cafeId, cafeName }, Date.now(), ctx.reviewDelayMs ?? reviewPromptDelayMs);
  if (!planned) return;
  scheduleReviewTimer(ctx.space.id, planned.dueAt, async () => {
    // Timers can fire a moment early; a second of slack keeps that from skipping the question.
    await askReviewIfDue(ctx, joloState(ctx.space.id), Date.now() + 1000);
    touch(ctx.space.id);
  });
}

async function askReviewIfDue(ctx: JoloContext, state: JoloState, now = Date.now()): Promise<void> {
  if (!reviewDue(state, now) || !state.review) return;
  cancelReviewTimer(ctx.space.id);
  markAsked(state);
  await ctx.say(copy.reviewPrompt(state.review.cafeName));
}

const WENT = /\b(went|been|did|definitely|absolutely|loved|of course)\b/iu;
const STOP = /\b(cancel|stop|never ?mind|forget it)\b/iu;

/** True when the reply was about the review; false hands it on as a normal message. */
async function answerReview(ctx: JoloContext, state: JoloState, text: string): Promise<boolean> {
  const review = state.review!;
  const decline = async () => {
    delete state.review;
    await ctx.say(copy.reviewDeclined);
    return true;
  };

  if (review.stage === "asked") {
    const rated = parseRating(text);
    let went = parseConfirm(text);
    if (went === null && (rated || WENT.test(text))) went = true;
    if (went === null) {
      // Not an answer (a new question, say): drop the review and let the agent answer it.
      delete state.review;
      return false;
    }
    if (!went) return decline();
    if (rated) return gotRating(ctx, state, rated.rating, withoutYes(rated.rest));
    review.stage = "rating";
    await ctx.say(copy.reviewAskRating(review.cafeName));
    return true;
  }

  if (review.stage === "rating") {
    const rated = parseRating(text);
    if (rated) return gotRating(ctx, state, rated.rating, rated.rest);
    if (parseConfirm(text) === false || STOP.test(text)) return decline();
    review.misses = (review.misses ?? 0) + 1;
    if (review.misses > 1) {
      delete state.review;
      return false;
    }
    await ctx.say(copy.reviewAskRatingAgain);
    return true;
  }

  // The comment question.
  return save(ctx, state, skipsComment(text) ? "" : text.trim());
}

async function gotRating(ctx: JoloContext, state: JoloState, rating: number, rest: string): Promise<boolean> {
  const review = state.review!;
  review.rating = rating;
  delete review.misses;
  // "5, the cortado was perfect": the comment came with the rating.
  if (isComment(rest)) return save(ctx, state, rest);
  review.stage = "comment";
  await ctx.say(copy.reviewAskComment);
  return true;
}

async function save(ctx: JoloContext, state: JoloState, comment: string): Promise<boolean> {
  const review = state.review!;
  try {
    await (ctx.saveReview ?? saveReview)({
      phone: ctx.message.sender?.id ?? "",
      cafeId: review.cafeId,
      cafeName: review.cafeName,
      rating: review.rating ?? 0,
      comment,
    });
  } catch (error) {
    console.error(`[jolo] review not saved: ${error instanceof Error ? error.message : error}`);
    review.stage = "comment";
    await ctx.say(copy.reviewSaveFailed);
    return true;
  }
  delete state.review;
  await ctx.say(copy.reviewSaved(review.cafeName));
  return true;
}
