# JOLO

![JOLO](docs/design/logo.svg)

> Hackathon project. **Café owners text a photo of their menu; JOLO reads it, confirms the changes, and keeps the menu current everywhere. Customers text JOLO to ask what's on the menu.**

This repo holds the whole project. It started as Ricardo's menu reader; Isaiah's iMessage bridge, owner app and product docs were merged in beside it.

## Who owns what

| | Owner | What | In this repo |
|---|---|---|---|
| 👁️ **Eyes** | Ricardo | Photo → menu data: intake, read (Qwen3.5-9B with vision), validate, confidence, compare and merge, evaluation | [`menu_reader/`](menu_reader) ([README](menu_reader/README.md)), [`eval/`](eval), [`scripts/`](scripts), [`tests/`](tests), `config.yaml` |
| 🗣️ **Voice and Face** | Isaiah | iMessage connection, conversation design, the JOLO owner app, design and product | [`spectrum-archive-app/`](spectrum-archive-app), [`jolo-app/`](jolo-app), [`docs/`](docs) |
| 🧠 **Brain** | Bhavesh | Agent (tool calling), Firestore and search index, model serving on AWS, owner insights | [`jolo_agent/`](jolo_agent), [`api/`](api), [`agent_eval/`](agent_eval) ([`docs/brain.md`](docs/brain.md)); implements [`docs/contracts.md`](docs/contracts.md) §2 |

```
Owner / Customer
      │ iMessage (photos + text)
      ▼
spectrum-archive-app ── onboarding, wording, wait message, pending questions, archive    (Isaiah)
      │ POST /v1/turn  { sender.handle, event: message | scope | confirm | correction }
      ▼
Agent ── find_cafe_by_phone · extract_menu · merge_results · get_menu · save_menu_version (Bhavesh)
      │                      │
      │                      └──▶ menu_reader: open · read · validate · confidence · compare (Ricardo)
      │                                  │ HTTP
      │                                  └──▶ Qwen3.5-9B on the GPU VM (vLLM, port 8000)
      ▼
Firestore  cafes/{id} · menuVersions/{n} · insights/{week}   ◀── jolo-app (owner dashboard, live) (Isaiah)
```

## Documents

| Read this | For |
|---|---|
| [`docs/team-responsibilities.md`](docs/team-responsibilities.md) | Who owns what, as a chart |
| [`docs/brain.md`](docs/brain.md) | The agent: how to run it, config, API, evaluation numbers, what's left |
| [`docs/menu-update-flow.md`](docs/menu-update-flow.md) | One menu update, step by step, across the team |
| [`docs/integration-guide.md`](docs/integration-guide.md) | Ricardo's checklist for connecting the agent and the interface to the reader |
| [`docs/contracts.md`](docs/contracts.md) | The interfaces: Firestore schema, bridge ↔ agent (`POST /v1/turn`), agent ↔ reader |
| [`docs/conversation-design.md`](docs/conversation-design.md) | Everything JOLO says over iMessage, and when |
| [`docs/test-flow.md`](docs/test-flow.md) | How to test it, stage by stage, from unit tests to a real text message |
| [`docs/model-plan.md`](docs/model-plan.md) | The team's model plan |
| [`docs/product.md`](docs/product.md), [`docs/design/brand.md`](docs/design/brand.md) | User stories, business model, sponsor prizes, brand |
| [`docs/trends-and-insights.md`](docs/trends-and-insights.md) | The data scraper: owner Insights, customer trends, and how to run the job |
| [`docs/drink-recommendations.md`](docs/drink-recommendations.md) | User side: taste, scrape, and drink cards from the live menu |
| [`menu_reader/README.md`](menu_reader/README.md) | The menu reader's full reference, results and known limits |

## Quick start

### Menu reader (Python, from the repo root)

```bash
python -m venv .venv && source .venv/bin/activate
python -m pip install paddlepaddle==3.2.0 -i https://www.paddlepaddle.org.cn/packages/stable/cpu/
python -m pip install -r requirements.txt
python -m pytest -q                # needs no model server
```

Reading a real photo needs the Qwen server; see [`menu_reader/README.md`](menu_reader/README.md).

### Brain (the agent and its API)

```bash
python -m pip install -r requirements-agent.txt -c requirements.txt   # torch note at the top of that file
python scripts/seed_store.py --owner +16095550100=barbaras
python scripts/build_index.py
python -m uvicorn api.app:create_app --factory --port 8080          # the bridge's AGENT_URL
python scripts/chat.py --phone +16095550100                         # text it from the terminal
```

The model server must be reachable on `localhost:8000`. The full guide is [`docs/brain.md`](docs/brain.md).

### iMessage bridge (no credentials needed)

Run the bridge in the terminal against the stand-in agent. Start the stub first:

```bash
cd spectrum-archive-app && npm install && npm run agent:stub
```

Then, in a second terminal:

```bash
cd spectrum-archive-app && AGENT_URL=http://127.0.0.1:8788 npm start
```

Real iMessage needs `PROJECT_ID`/`PROJECT_SECRET` from Photon; see [`spectrum-archive-app/README.md`](spectrum-archive-app/README.md).

### Owner app

See [`jolo-app/README.md`](jolo-app/README.md). It needs a development build and a Firebase project, or the local emulators with Java 21.

## Still to agree as a team

- [x] **Firestore as the main database.**
- [ ] **The menu item format.** Proposal: Firestore stores the reader's item shape as it is (`section`, `item`, `category`, `prices[{size, usd}]`, `confidence`), plus `id` and `available`. See [`docs/contracts.md`](docs/contracts.md) §1.
- [x] **The bridge ↔ agent contract** (`POST /v1/turn`): implemented in [`api/turn.py`](api/turn.py); still to try against the real bridge on a Mac.
- [ ] **iMessage transport.** The bridge uses Photon's Spectrum Cloud. [`docs/model-plan.md`](docs/model-plan.md) asks for the local iMessage Kit so no message leaves our hardware. Pick one before the pitch claims "our own hardware".
- [ ] **Where the agent runs,** one Qwen server or two, and where owner corrections are stored (questions at the end of [`docs/integration-guide.md`](docs/integration-guide.md)).
- [ ] **Which sponsor prizes to go for.** See [`docs/product.md`](docs/product.md#sponsor-prizes).

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs the menu reader's and the brain's tests, the bridge's and the app's checks, and the Firestore rules tests on every pull request.
