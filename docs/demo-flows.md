# Demo flows

Two scripted walkthroughs for showing JOLO: one as a café **owner**, one as a **customer**. Each takes about four minutes. They're written to run back to back with two phones, so what one person does shows up on the other's screen.

Each step lists what you do, what JOLO texts back or what the app shows, and the point to make while it happens. Text in quotes is what to type. JOLO's replies come from [`copy.ts`](../spectrum-archive-app/src/jolo/copy.ts) and [conversation-design.md](conversation-design.md); if a reply here doesn't match, the code is right and this page is stale.

## Before you start

| | |
|---|---|
| **Two phones** | An **owner phone** linked to Barbara's (`ownerPhone`), and a **customer phone** linked to no café. Both need iMessage and the JOLO dev build. |
| **Everything running** | Bridge, agent, menu reader and Firestore, as in [test-flow.md, Stage 5](test-flow.md#stage-5-everything-over-imessage). Use the **real agent**. The stub keeps its menu in memory and never writes Firestore, so the app wouldn't update. |
| **Short review delay** | Start the bridge with `REVIEW_PROMPT_DELAY_MS=60000`, so the review question comes after 1 minute instead of 2 hours. |
| **Fresh conversations** | Text `/reset` from both phones, so onboarding starts from the beginning. |
| **A menu photo** | A photo of Barbara's board with one changed price (**Cortado $4.75**, live price $4.50) and one new drink (**Oat Latte**). Print it or keep it on a second screen. |
| **Insights filled in** | Run the weekly insights and the trends job once ([brain.md](brain.md#weekly-insights), [trends-and-insights.md](trends-and-insights.md)), so Insights and Social aren't empty. |

Both phones should start signed out of the app.

---

## Flow 1: Owner

> **The story:** Barbara changes her menu board. She updates the menu everywhere with one photo, and she never logs in to anything to do it.

### 1. Sign up by text (iMessage)

| You do | JOLO replies |
|---|---|
| Text "hi" | Are you an owner or a user? |
| "owner" | What is your name, business name, and location? |
| "Barbara, Barbara's, Westfield" | Thanks, Barbara. Barbara's in Westfield is linked to this phone number. Sign in to the app with it and you'll see this there. |

**Say:** Onboarding is one text. No app download, account or password.

### 2. Text a photo of the menu board

| You do | JOLO replies |
|---|---|
| Send the menu photo | Reading your menu… this can take a minute. |
| | Is this your full menu, or just part of it? |
| "just part of it" | Found 1 new item and 1 price change. Cortado now $4.75? |
| | `+ Oat Latte $5.00` · `• Cortado $4.50 → $4.75` |
| | Reply "yes" to save or "no" to cancel. If something is off, tell me what to fix. |

**Say:** A vision model on our own GPU reads the board. JOLO shows only what changed, and nothing is saved yet. Because Barbara said "part", items that aren't in the photo are kept, not deleted.

*Optional:* send a second photo before answering ("Got it, reading that one too…"). JOLO merges both photos into one update.

### 3. Correct it in plain words, then confirm

| You do | JOLO replies |
|---|---|
| "the oat latte is 5.25" | The summary again, now with `+ Oat Latte $5.25`, and the same yes/no question |
| "menu" *(optional)* | Here's the whole menu: every item, then the same question. Nothing is saved. |
| "yes" | Your menu is updated ✅ |

**Say:** A fix is just a sentence. Nothing goes live until Barbara answers the corrected summary with a plain "yes".

### 4. Open the app: the menu is already there

Sign in with the owner phone number: enter it, tap **Text me a code**, enter the code, then tap **Sign in**.

- **Menu** tab: "Version N · updated today by text". Cortado shows $4.75 and Oat Latte is listed.
- If the reader was unsure about anything, a banner says "JOLO wasn't sure about 1 item" and that row is marked **Check this**.

**Say:** Signing in uses the café's phone number, which is how JOLO knows she's the owner. The app listens to Firestore, so the texted update arrived on its own.

### 5. Edit in the app

- Flip **Croissant** to sold out. Tap **Cortado** and fix a price in the editor.
- The save bar lists the pending changes. Tap **Save changes** to see "Saved as version N+1. Customers see it now."

**Say:** Text and app share one store. Every save, by text or in the app, becomes a new version.

### 6. History

**History** tab: every version, newest first. The live one is outlined. Each card says **by text** or **in the app**, lists its changes, and the photo update is marked "Partial photo — items not shown were kept".

**Say:** Nothing is overwritten. Barbara can see who changed what, and when.

### 7. Insights

**Insights** tab, top to bottom:

- **Suggestions**: what to add, feature or bring back, with the reasons (e.g. oat milk, because customers ask for it and shops nearby added it).
- **Your menu**: items, drink price range, items to check, sold out, price changes this month.
- **Customer asks**: this week's questions and customers compared with last week, the most asked-about items, and a plain-English summary.
- **Other shops**, **Asked near you**, **On the web**: what's trending, from other cafés' menus, JOLO searches in town, café blogs and Reddit.

**Say:** Customers asking JOLO about menus is the data. Barbara sees what people want before she prints a new board.

*Optional:* text JOLO "how many people asked about my menu this week?". The agent answers from the same insights.

### 8. Reviews *(after Flow 2, step 5)*

**Reviews** tab: the average rating, a bar for each star count, and every review, newest first. The customer's iMessage review and app review appear here live while you watch.

**Say:** Feedback by text and by app ends up in one place, about one café.

---

## Flow 2: Customer

> **The story:** Sam wants a good oat latte nearby, and wants to know the price before walking over.

Run steps 1–2 right after Flow 1, step 3, so the new prices are live.

### 1. Sign up by text (iMessage)

| You do | JOLO replies |
|---|---|
| Text "hi" | Are you an owner or a user? |
| "user" | Welcome to JOLO ☕ Sign in to the JOLO app with this phone number to find cafés near you and see what they're serving. |

**Say:** Same number, same one question. A customer can just keep texting.

### 2. Ask about a menu

| You do | JOLO replies |
|---|---|
| "What's on the menu at Barbara's?" | The items and prices, including **Cortado $4.75** and **Oat Latte $5.25**, with how fresh it is ("updated today") |

**Say:** That's the price Barbara confirmed a minute ago. Every price comes from the live menu, and the agent never makes one up.

### 3. Search like a person

Pick two or three of these. The agent picks the tools; the replies are its own words, so they vary.

| You ask | What it uses |
|---|---|
| "Where can I get an oat milk latte near Westfield that's open now?" | Café search (meaning-based, filtered by open now) and the menus |
| "How far is Barbara's from Westfield station?" | Distance |
| "Is it open Sunday morning?" | Opening hours |
| "Okay, I'm going to Barbara's" | Records the pick |

**Say:** Sam can ask in their own words. JOLO is search, menus, hours and directions in one text thread.

### 4. Leave a review by text

About a minute later (the short `REVIEW_PROMPT_DELAY_MS`), without Sam asking:

| You do | JOLO replies |
|---|---|
| | Let us know if you went to Barbara's, and want to leave a review. Reply "yes" or "no". |
| "yes, 5" | Thanks! What did you think? Reply "skip" to leave just the rating. |
| "perfect oat latte" | Thanks! Your review of Barbara's is on the Social tab in the JOLO app. |

**Say:** JOLO follows up once, about the café Sam looked at. "yes, 5" answers two questions at once. The review is saved without Sam's phone number.

### 5. Open the app

Sign in with the customer phone number. This phone owns no café, so the customer side opens.

- **Finder**: a map of nearby cafés. Search "Westfield", tap the filter icon to show independent cafés only, tap Barbara's for its card, then **Directions**.
- **For you**: **What you like** already shows what Sam asked JOLO over iMessage ("oat milk latte near Westfield…"). Hearting a drink under **Trending now** saves it. **History** lists Barbara's.
- **Social**:
  - **Trending near you**: drinks trending on local menus, at real prices.
  - **Picked for you**: drinks picked from Sam's searches.
  - **Reviews**: the review Sam texted. It says "iMessage guest", because Sam had no app account when they texted it. Reviews texted after signing in show the account's name.
  - Tap **Write**, pick a café, give it stars and a comment, and **Post**.

**Say:** The texts and the app are one account. What Sam asked by iMessage shapes what the app recommends.

Switch to the owner phone for **Flow 1, step 8**: both reviews are on Barbara's Reviews tab.

---

## If something goes wrong on stage

| You see | Do |
|---|---|
| "I couldn't read that photo. Can you send a clearer one?" | Send a sharper, straight-on photo. The open update is kept. |
| "I can't read menus right now. Try again in a minute." | The model server or its tunnel is down. Check the GPU VM, then resend. |
| "I couldn't reach the menu service just now." | The agent isn't reachable from the bridge. Check `AGENT_URL`. |
| "I couldn't find a café linked to this phone number." | The owner phone isn't Barbara's `ownerPhone`. Link it with `npm run link-owner` ([jolo-app README](../jolo-app/README.md)). |
| The app says "No café linked yet" | Same cause. The screen updates as soon as the café is linked. |
| No review question | Check that the bridge was started with `REVIEW_PROMPT_DELAY_MS`, and that the customer asked about one café (the agent has to send `cafe_interest`). |
| Insights or Social are empty | The insights and trends jobs haven't run against this Firestore. |
| An onboarding question is skipped | That phone already finished onboarding. Text `/reset`. |
