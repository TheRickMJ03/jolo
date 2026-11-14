# JOLO

![JOLO](docs/design/logo.svg)

> Hackathon project. **Café owners text a photo of their menu; JOLO reads it, confirms the changes, and keeps the menu current everywhere. Customers text JOLO to ask what's on the menu.**

## Who owns what

| | Owner | What | In this repo |
|---|---|---|---|
| 🗣️ **Voice and Face** | Isaiah | iMessage connection, conversation design, the JOLO owner app, design and product | [`spectrum-archive-app/`](spectrum-archive-app), [`jolo-app/`](jolo-app), [`docs/`](docs) |
| 🧠 **Brain** | Bhavesh | Agent (LangChain, tool calling), Firestore and search index, model serving on AWS, owner insights | not yet; the interface is [`docs/contracts.md`](docs/contracts.md) §2 |
| 👁️ **Eyes** | Ricardo | Photo → menu JSON: intake, find the menu (SAM 3), read it (GLM-OCR), validate and compare | not yet; the interface is [`docs/contracts.md`](docs/contracts.md) §3 |

```
Owner / Customer
      │ iMessage (photos + text)
      ▼
spectrum-archive-app ── onboarding, wording, pending questions, Parquet archive          (Isaiah)
      │ POST /v1/turn  { sender.handle, event: message | scope | confirm }
      ▼
Agent ── find_cafe_by_phone · extract_menu · get_menu · save_menu_version · search_cafes  (Bhavesh)
      │                      │
      │                      └──▶ Menu reader: crop · read · validate · compare          (Ricardo)
      ▼
Firestore  cafes/{id} · menuVersions/{n} · insights/{week}   ◀── jolo-app (owner dashboard, live) (Isaiah)
```

## Isaiah's pieces

| From the plan | Where it is | Status |
|---|---|---|
| **Photon: Agents in iMessage** | [`spectrum-archive-app`](spectrum-archive-app), built on Photon's Spectrum SDK, with iMessage through Spectrum Cloud | ✅ Built. Real iMessage needs `PROJECT_ID`/`PROJECT_SECRET`. |
| **iMessage connection**: receive photos and texts, send replies | [`spectrum-archive-app/src/jolo/`](spectrum-archive-app/src/jolo): photos and captions are collected and sent to the agent; replies come back as actions | ✅ Tested end to end against a stub agent |
| **Conversation design**: onboarding (name, owner or customer), "Full menu or part of it?", confirmation texts | [`docs/conversation-design.md`](docs/conversation-design.md), [`copy.ts`](spectrum-archive-app/src/jolo/copy.ts), [`parse.ts`](spectrum-archive-app/src/jolo/parse.ts) | ✅ Built |
| **JOLO app**: login with phone number; owner dashboard with menu, edits and insights | [`jolo-app/`](jolo-app): phone sign-in plus email; live Menu, History, Insights and Account tabs; owner-only Firestore rules | ✅ Built and unit/screen tested. Needs Firebase console setup (see its README). |
| **Design and product**: UI/UX, logo, colours, user stories, business model | [`docs/design/brand.md`](docs/design/brand.md), [`docs/design/logo.svg`](docs/design/logo.svg), [`docs/product.md`](docs/product.md) | ✅ Drafted |
| **Salesforce · Capital One**: small-business owner tools | [`docs/product.md`](docs/product.md#sponsor-prizes) | ⚠️ Possible fit. **Check the prize criteria.** |

## Still to agree as a team

From the team chat, with Isaiah's proposals in [`docs/contracts.md`](docs/contracts.md):

- [x] **Firestore as the main database.** The JOLO app already uses it, and Bhavesh's search index is built from it. The schema is proposed in §1.
- [ ] **The menu JSON format** between Ricardo's reader and the agent: MenuItem with `priceCents`. _Open:_ per-field confidence.
- [ ] **The bridge ↔ agent contract** (`POST /v1/turn`), so Bhavesh can build to it.
- [ ] **Which sponsor prizes to go for.** See [`docs/product.md`](docs/product.md#sponsor-prizes).

## Quick start (Isaiah's parts, no credentials needed)

Run the iMessage bridge in the terminal against the stand-in agent. Start the stub first:

```bash
cd spectrum-archive-app && npm install && npm run agent:stub
```

Then, in a second terminal:

```bash
cd spectrum-archive-app && AGENT_URL=http://127.0.0.1:8788 npm start
```

For the owner app, see [`jolo-app/README.md`](jolo-app/README.md). It needs a development build and a Firebase project, or the local emulators with Java 21.

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs both apps' checks and the Firestore rules tests on every pull request.
