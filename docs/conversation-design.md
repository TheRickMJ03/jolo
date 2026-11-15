# Conversation design

Everything JOLO says over iMessage, and when it says it. The wording lives in code in [`spectrum-archive-app/src/jolo/copy.ts`](../spectrum-archive-app/src/jolo/copy.ts). Change it there, and this page with it.

## Voice

- **Short.** Text messages, not emails. Each message is one or two lines, plus a list when one helps.
- **Warm, plain words.** A neighbourhood café's tone, not a bank's. Use the person's name once they've given it, then sparingly.
- **One question at a time,** with the expected answer shown in quotes ("yes" / "no"). iMessage shows asterisks literally, so there's no bold.
- **Use emoji only as a status marker:** ☕ in the greeting and ✅ when something saved. Nowhere else.
- **Never make up a fact.** Menu answers come from the agent, which reads Firestore. The bridge never guesses a price.

## 1. Onboarding: the first message from someone new

The bridge runs this before anything reaches the agent. It's stored per conversation, and `/reset` starts it over.

| Step | JOLO says | Reply accepted | Re-ask when unclear |
|---|---|---|---|
| Role | Are you an owner or a user? | owner, I own…, café owner, 1; or user, customer, 2 | Reply "owner" if you run the café, or "user" if you don't. |
| User welcome | Welcome to JOLO ☕ Sign in to the JOLO app with this phone number to find cafés near you and see what they're serving. | – | – |
| Owner details | What is your name, business name, and location? | Three parts separated by commas or new lines. A street address may contain commas; the first part is the name, the second the business, the rest the location. | Send all three, separated by commas. For example: "Isaiah, Barbara's, Westfield". |
| Owner welcome | Thanks, {name}. {business} in {location} is linked to this phone number. Sign in to the app with it and you'll see this there. | – | – |

The three answers are written to the café whose `ownerPhone` is the sender's number, so the app shows the name, business, and location when that number signs in.

A reply of "user" finishes onboarding with nothing written. That number has no café, so the app opens the customer side (Finder, Social, Favorites, Profile) when it signs in. Later texts go to the agent with `role: "customer"`.

If an owner's first message is a photo, it isn't lost: once onboarding finishes, JOLO asks them to send it again ("Send that photo again and I'll read it.").

## 2. Owner updates the menu (sequence diagram, steps 1–21)

| When | JOLO says |
|---|---|
| A photo arrives (sent by the bridge at once, before the agent is called) | Reading your menu… this can take a minute. |
| Another photo arrives while the same update is open | Got it, reading that one too… |
| Agent returns `ask_scope` | Is this your full menu, or just part of it? |
| Unclear answer | Sorry, I didn't catch that. Is the photo your "full" menu, or just "part" of it? |
| Agent returns `confirm_changes` | Found 2 new items and 3 price changes. Cortado now $4.75? |
|  | followed by up to 6 lines, e.g. `+ Oat Latte $5.00`, `+ Latte 12 oz $3.50 / 16 oz $4.25`, `• Cortado $4.50 → $4.75`, `• Latte (16 oz) $4.25 → $4.50`, `– Muffin (removed)` |
|  | If there are more: `…and 3 more. Reply "menu" to see the whole menu.` |
|  | Reply "yes" to save or "no" to cancel. If something is off, tell me what to fix. |
| The owner asks to see the whole menu | Here's the whole menu: then every line, then the same yes/no question. Nothing is saved, and the agent is not called. |
| Unclear answer | Reply "yes" to save these changes, or "no" to leave your menu as it is. Or tell me what to fix, like "the cortado is 4.50". |
| The owner replies with a fix | The fix goes to the agent as a `correction`; the updated summary comes back and the question is asked again. |
| Agent returns `menu_updated` | Your menu is updated ✅ |
| Agent returns `cancelled` | Okay, nothing changed. Send another photo whenever you're ready. |
| Agent returns `not_owner` | I couldn't find a café linked to this phone number. Ask the JOLO team to link it, then send the photo again. |

How the summary headline is built from the changes:

- Only the non-empty parts are named: "Found 2 new items", "Found 3 price changes", "Found 1 new item and 1 removed item".
- One price change is quoted as the question, in the diagram's style: "Cortado now $4.75?".
- With no price change to quote, the question is the new item the reader is least sure of: "Found 24 new items. Latte 12 oz $3.50 / 16 oz $4.25?". That is how a café's first menu reads.
- **New items are listed least confident first.** The reader is strong on prices and weaker on size names and on telling decoration from menu items, so the lines the owner sees are the ones most worth checking.
- A size that is new reads `• Latte (20 oz) new at $5.00`; one that is gone reads `• Latte (8 oz) $3.00 → no longer listed`.
- If nothing changed: "That looks the same as your current menu, so there's nothing to save." No question is asked.

Accepted answers:

| Question | Answer | Accepted words |
|---|---|---|
| Scope | **full** | full, whole, entire, all, everything, complete, the whole thing |
| Scope | **partial** | part, partial, some, just a section, only, half |
| Confirm | **yes** | yes, y, yep, yeah, ok, sure, correct, right, good, looks good, all correct, 👍 ✅ |
| Confirm | **no** | no, n, nope, nah, wrong, incorrect, cancel, stop, 👎 ❌, or any negation ("not correct", "don't save") |
| Confirm | **the whole menu** | menu, the whole menu, entire menu, view the entire menu, show me the menu, show all, see everything, the rest |
| Confirm | **a fix** | anything with a number in it, or one of: should, change, rename, remove, delete, add, called, except, but, instead, actually, size, spelled, price, oz |

A reply that matches both yes and no, or neither, is unclear, and JOLO asks again. Asking to see the whole menu only lists the items: a yes, a no, or a fix in the same text still wins, so "yes, all correct" saves and "the cortado is 4.50" is a fix.

A fix wins over yes and no: "no, the cortado is 4.50" and "yes, but not the croissant" are both sent to the agent as corrections, so a fix is never saved or thrown away by accident. Nothing is saved until the owner answers the updated summary with a plain yes.

### Several photos of one menu

Owners often send a menu in parts. Until the update is saved or cancelled, every further photo joins it: the agent merges the photos and sends the scope question or the summary again for the whole menu. Text still answers whichever question is open.

## 3. Customer asks about a menu (steps 22–27)

The customer's text goes to the agent unchanged, and the agent's `say` text comes back unchanged, for example: "Cortado $4.75, Latte $3.50… (updated today)". The bridge adds nothing, so every price comes from Firestore.

### Reviews

When the agent's answer includes `cafe_interest` (the customer asked about a café, or the top café from a search), the bridge plans one question about that café for later: `REVIEW_PROMPT_DELAY_MS` after the message, two hours by default. A café looked at later replaces one not asked about yet. A customer is asked about each café once, and only one review is open at a time. Owners are never asked. If the bridge restarts before the timer fires, the question goes out right after the customer's next message.

| Step | JOLO says |
|---|---|
| The time is up | Let us know if you went to Barbara's, and want to leave a review. Reply "yes" or "no". |
| Yes | How would you rate Barbara's from 1 to 5? |
| Unclear rating (once) | Reply with a number from 1 to 5, like "4". |
| A rating | Thanks! What did you think? Reply "skip" to leave just the rating. |
| A comment, or "skip" | Thanks! Your review of Barbara's is on the Social tab in the JOLO app. |
| No, or "cancel" during the rating | No problem. Enjoy your coffee ☕ |
| The save failed | I couldn't save your review just now. Send your comment again in a minute. |

Accepted answers: yes is the confirm yes list plus "went", "been", "did", "loved"; a rating is 1–5 as a digit, a word, "4/5", "4 out of 5", "4 stars" or ⭐⭐⭐⭐. A rating sent with the yes ("yes, 5") skips the rating question, and words sent with the rating ("5, perfect oat latte") are the comment. A reply that isn't an answer to "did you go?" (a new question), or a second unclear rating, drops the review and goes to the agent as a normal message.

The review is saved to Firestore `reviews/{id}` with `source: "imessage"`. It names the app account signed in with this phone number, or "iMessage guest"; the phone number itself is never stored.

## 4. When things go wrong

| Situation | JOLO says |
|---|---|
| Agent returns `unreadable_photo` (the reader couldn't use the photo) | I couldn't read that photo. Can you send a clearer one? |
| Agent returns `reader_down` (the model server didn't answer) | I can't read menus right now. Try again in a minute. |
| Agent unreachable, timed out, or returned an error | I couldn't reach the menu service just now. Please try again in a minute. |
| More than 5 photos | I can read up to 5 photos at a time. I'll use the first 5. |
| A non-image attachment or a voice note | I can only read photos and text for now. |
| Photo too large (> 10 MB) | That photo is too large for me to read. Could you send a smaller one? |

Any question that was pending stays pending, so the owner can just answer again. That includes a photo that couldn't be read partway through an update: the earlier photos and the open question are kept.

Photos are passed to the agent as the original file (HEIC, JPG, PNG or WebP). The bridge never shrinks or re-encodes them, because small text is what the reader struggles with.

## Commands (all platforms)

`/help`, `/ping`, `/whoami` (now also shows name and role), `/reset` (forgets the conversation, including onboarding).
