# Test flow

How to test JOLO, from one part on its own up to a real text message. Each stage adds one real piece in place of a stand-in, so when something breaks you know which piece broke it.

| Stage | What is real | What is a stand-in | Needs | Who |
|---|---|---|---|---|
| [0. Automated suites](#stage-0-automated-suites) | Each part's own logic | Everything outside the part | Nothing | CI, everyone |
| [1. Conversation in the terminal](#stage-1-conversation-in-the-terminal) | The bridge | Agent (stub), iMessage (terminal) | Nothing | Isaiah |
| [2. Reader on its own](#stage-2-reader-on-its-own) | The reader and the model | – | GPU VM, tunnel | Ricardo |
| [3. Agent against the contract](#stage-3-agent-against-the-contract) | Agent, reader, Firestore | Bridge (`curl`) | VM, the agent | Bhavesh |
| [4. Owner app on the emulator](#stage-4-owner-app-on-the-emulator) | The app, Firestore rules | Firestore (emulator), seeded menu | Java 21, a dev build | Isaiah |
| [5. Everything, over iMessage](#stage-5-everything-over-imessage) | All of it | – | All of the above, Photon project | Together |

Run the stages in order before a demo. A stage is done when every flow in it gives the expected result.

## The flows

The same ten flows are used at stages 1, 3 and 5. The exact wording is in [`conversation-design.md`](conversation-design.md).

| # | Flow | Do this | Expect |
|---|---|---|---|
| F1 | Onboarding | Text "hi", then a name, then "owner" | Greeting, "Nice to meet you, {name}!", then the owner welcome. The agent is not called. |
| F2 | Update, part of the menu | Send a menu photo, answer "part", answer "yes" | "Reading your menu…" at once; the scope question; a summary with no removals; "Your menu is updated ✅" |
| F3 | Update, full menu | Send a photo, answer "full", answer "no" | The summary lists items missing from the photo as removed; "Okay, nothing changed." |
| F4 | A fix | At the summary, reply "no, the cortado is 4.60" | The summary comes back with the cortado at $4.60 and asks again. Nothing is saved until "yes". |
| F5 | Menu in several photos | Send a photo, then a second before answering | "Got it, reading that one too…"; one summary for the whole menu |
| F6 | Photo can't be read | Send a photo that isn't a menu, or is too blurred | "I couldn't read that photo. Can you send a clearer one?" The open question still stands. |
| F7 | Reader is down | Stop the model server, send a photo | "I can't read menus right now. Try again in a minute." |
| F8 | Agent is down | Stop the agent, send any text | "I couldn't reach the menu service just now…" The open question still stands. |
| F9 | Not the owner | Send a photo from a number no café is linked to | "I couldn't find a café linked to this phone number…" Nothing changes. |
| F10 | Customer question | From another number, after F2: "What's on the menu at Barbara's?" | The prices saved in F2, and nothing the menu doesn't have |

## Stage 0: Automated suites

No credentials, no network, no model server.

```bash
bash scripts/test_all.sh
```

| Suite | Command | Covers |
|---|---|---|
| Menu reader | `python -m pytest -q` (repo root) | Intake, validation, confidence, compare, merge, the eval harness |
| Bridge | `npm run typecheck && npm test` in `spectrum-archive-app/` | F1 to F10 against the stub agent over HTTP, the reply parsers, the summary wording, the archive |
| Owner app | `npm run lint && npm run typecheck && npm test` in `jolo-app/` | Menu logic (prices, sizes, diffs), the menu and sign-in screens |
| Firestore rules | `npm run test:rules` in `jolo-app/` | Who can read and write what. Needs Java 21, so `test_all.sh` skips it when Java is older; CI always runs it. |

CI runs all four on every pull request.

## Stage 1: Conversation in the terminal

The bridge with a stand-in agent that plays one café, "Barbara's". Start the stub, then the bridge in a second terminal:

```bash
cd spectrum-archive-app && npm run agent:stub
```

```bash
cd spectrum-archive-app && AGENT_URL=http://127.0.0.1:8788 npm start
```

Run F1 to F6 and F8 by typing. Drag an image file into the terminal to send a photo.

- The stub does not read photos: every photo "shows" the same 2 new items and 3 price changes.
- For F6, send a file whose name contains `blurry`. For F7, one whose name contains `offline`.
- For F8, stop the stub (Ctrl-C) and send a message.
- For F9 and F10, the stub's owner is `terminal-user`; restart it with `STUB_OWNER_HANDLES=someone-else` to become a non-owner.
- `/reset` forgets the conversation, so F1 can be run again.

## Stage 2: Reader on its own

Ricardo's checks, from [`integration-guide.md`](integration-guide.md). With the VM and the tunnel up:

```bash
python scripts/warmup.py
```

```bash
python scripts/read_photo.py path/to/menu.jpg
```

- [ ] `warmup.py` prints `Server is up` and a short menu.
- [ ] The **demo photo**, taken on a phone, reads sensibly. Look at `output/<name>.json`: item count, prices, size names.
- [ ] A HEIC straight from an iPhone opens.
- [ ] With the server stopped, the result is `readable: false` with a `reason` starting `model_error`.

## Stage 3: Agent against the contract

Bhavesh's agent with the real reader and Firestore, driven by `curl` in place of the bridge. This proves the agent speaks [`contracts.md`](contracts.md) §2 before a phone is involved.

```bash
curl -s "$AGENT_URL/v1/turn" -H 'content-type: application/json' -d '{
  "conversation_id": "test-1", "platform": "terminal",
  "sender": {"handle": "+19085551234", "name": "Barbara", "role": "owner"},
  "event": {"type": "message", "text": "What is on the menu?", "photos": []}
}'
```

A photo goes in `photos` as `{"name", "mime_type", "data_base64"}`; `base64 -i menu.heic` gives the last field.

- [ ] Every response is `{"actions": [...]}` using only the action types in the contract.
- [ ] A photo from a linked number returns `ask_scope`; a `scope` event returns `confirm_changes` with `added`, `price_changes` and `removed`.
- [ ] `removed` is empty after `"scope": "partial"`, whatever the photo is missing.
- [ ] A `correction` event returns a new `confirm_changes` and saves nothing.
- [ ] `confirm` with `true` writes `menuVersions/{n+1}` and moves `currentMenuVersion`; with `false` it writes nothing.
- [ ] A photo from an unlinked number returns `not_owner`.
- [ ] An unusable photo returns `unreadable_photo`; with the model server stopped, `reader_down`.
- [ ] A turn with a photo answers inside 300 seconds.

Then point the bridge at it (`AGENT_URL=…`, stage 1's second command) and run F1 to F10 in the terminal.

## Stage 4: Owner app on the emulator

Needs Java 21 and a development build; see [`jolo-app/README.md`](../jolo-app/README.md). Start the emulators, seed the demo café, then run the app:

```bash
cd jolo-app && npm run emulators
```

```bash
cd jolo-app && npm run seed:emulator
```

| # | Flow | Do this | Expect |
|---|---|---|---|
| A1 | Sign in | Enter (650) 555-1234; take the code from <http://localhost:4000/auth> | The Menu tab for Barbara's, version 3 |
| A2 | Read the menu | Look at the Menu tab | Items under Coffee, Bakery and Extras; Latte shows two sizes; "Fresh Daily" is marked "Check this" |
| A3 | Fix size names | Open Latte, change small/large to 12 oz/16 oz, save | Save bar shows `• Latte: sizes small / large → 12 oz / 16 oz`; saved as version 4 |
| A4 | Clear a check | Open Fresh Daily, then remove it or save it | The "Check this" marker and the banner go away |
| A5 | Sold out | Flip an item's switch, save | The item reads "Sold out"; a new version is saved |
| A6 | History | Open the History tab | Versions newest first, each with its changes; app edits and text updates look alike |
| A7 | Live update | Edit `cafes/demo-barbaras` in the emulator UI while the app is open | The Menu tab changes without a reload |
| A8 | Edit clash | Start an edit, change the version in the emulator UI, then save | "Your menu was just updated… Your edits are still here" |
| A9 | Not an owner | Sign in with a number no café is linked to | No café is shown, and nothing can be edited |

## Stage 5: Everything, over iMessage

The bridge on Spectrum with `PROJECT_ID` and `PROJECT_SECRET`, the real agent, the VM, and the app pointed at the real Firebase project. One phone is linked as the owner with `npm run link-owner`; a second phone is the customer.

- [ ] Ricardo: VM and model server up, `python scripts/warmup.py` run a few minutes before.
- [ ] Bhavesh: agent up; the owner's number is on the café's `ownerPhone`.
- [ ] Isaiah: bridge up with `AGENT_URL` set; app signed in as the owner.
- [ ] Run F1 to F10 from the phones, with the demo photo for F2.
- [ ] After F2's "yes", the app's Menu tab shows the new version without a reload, and History shows it as a text update.
- [ ] Time F2 from sending the photo to the summary. Note it; a read is expected to take 15 to 100 seconds.
- [ ] Ricardo: stop the VM afterwards.

## When a flow fails

| Symptom | Look at |
|---|---|
| No "Reading your menu…" | The bridge: is `AGENT_URL` set? Without it the JOLO flow is off. |
| "I couldn't reach the menu service" | The agent: is it up, is `AGENT_URL` right, did the turn take over `AGENT_TIMEOUT_MS`? The bridge logs the reason. |
| "I can't read menus right now" | The VM or the tunnel: `python scripts/warmup.py` |
| "I couldn't read that photo" on a good photo | Stage 2 with that photo: `python scripts/read_photo.py` |
| "I couldn't find a café linked to this phone number" | `ownerPhone` on the café; it must be the sender's number in E.164 form |
| Wrong items or prices in the summary | Stage 2 with that photo. The reader is weakest on size names and on decoration read as items. |
| Saved by text but not in the app | The app's Firebase project, and that the agent wrote `currentMenuVersion` |
