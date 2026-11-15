# The brain

Bhavesh's part: the agent that answers customers, runs the owner's menu update, and serves the iMessage bridge. Code: [`jolo_agent/`](../jolo_agent), [`api/`](../api), [`agent_eval/`](../agent_eval). It builds to [`contracts.md`](contracts.md) §2.

```
bridge ──POST /v1/turn──▶ api/turn.py ──▶ jolo_agent/brain.py ──▶ flow.py   (owner: one menu update at a time)
                                                              └──▶ agent.py  (LangGraph loop: model ⇄ tools)
                                                                     │
        store (memory JSON, or Firestore) ◀── tools.py ──────────────┤
        search index (BM25 + vectors + reranker) ◀───────────────────┘
        menu reader (Ricardo) ◀── flow.py, in a worker thread
```

## What it does

- **Customers:** find a café by item, vibe, hours, "open now" or distance; the answer is checked against the store (`grounding.py`), so it can't name an item or price that isn't there.
- **Owners:** a photo starts an update. The brain reads it (15 to 100 s, in the background), asks full or partial menu, shows the changes, takes corrections in plain words, and **saves only after an explicit yes**. Items missing from a photo are removed only when the owner said "full".
- **Ownership** is decided by the sender's handle, never by message text.

## Run it

From the repo root, in the venv (`pip install -r requirements.txt`, then `pip install -r requirements-agent.txt -c requirements.txt`; the torch note is at the top of that file).

```bash
# 1. The model server must be reachable on localhost:8000 (SSH tunnel to the VM):
ssh -N -L 8000:localhost:8000 <vm>

# 2. Put the 22 cafés in the store, and make a phone the owner of one:
python scripts/seed_store.py --owner +16095550100=barbaras

# 3. Build the search index (first run downloads about 1.2 GB of models to models/hf):
python scripts/build_index.py

# 4. Start the API:
python -m uvicorn api.app:create_app --factory --port 8080

# 5. Text it from the terminal (another terminal):
python scripts/chat.py --phone +16095550100 # as the owner; without --phone you are a customer
```

For a photo, start the line with the file's path: `demo/menu.jpg here is my full menu`.

Point the bridge at it with `AGENT_URL=http://<host>:8080` (and `AGENT_TOKEN` on both sides when the port is reachable by others). `GET /health` says whether the model server is reachable and whether search has vectors.

Without torch the brain still works; search falls back to keywords only.

## Configuration

`config.yaml`, section `common.agent` (every key can be overridden per profile).

| Key | Default | Meaning |
|---|---|---|
| `model`, `endpoint` | `qwen3.5-9b`, the profile's endpoint | The same vLLM server as the reader. |
| `tool_mode` | `json` | `native` (OpenAI tools), `json` (the model writes one JSON action), `auto` (native, then json if refused). See the numbers below for why `json`. |
| `max_tool_rounds`, `history_turns`, `timeout_seconds` | 5, 6, 120 | Loop limit, messages remembered per phone, model timeout. |
| `timezone` | `America/New_York` | For "open now". |
| `store.backend` | `memory` | `memory` is `data/store.json`; `firestore` uses the service-account key in `GOOGLE_APPLICATION_CREDENTIALS` (or `FIRESTORE_EMULATOR_HOST`). Translated to the app's schema; see "Firestore" below. |
| `api.host`, `api.port` | `127.0.0.1`, `8080` | Use `0.0.0.0` only with a key or token set. |
| `api.turn_timeout_seconds` | 280 | How long `/v1/turn` waits for a photo read; the bridge gives up at 300 s. |
| `api.callback_url` | `null` | Late `/messages` replies are posted here; otherwise poll `/outbox`. |
| `reads.workers` | 2 | Photos read at the same time. |
| `confirm.items_per_message` | 5 | Items the owner is asked to check at once. |
| `search.*` | | Index folder, models, `use_embeddings`, `use_reranker`, candidates, `max_miles`, and the `bandit` (off). Also `device` (`cpu`, `cuda` or `auto`), `rerank_min_words` (skip the reranker for queries shorter than this), `rebuild_on_start` and `refresh_seconds` (re-index menus the app edited; Firestore only). |
| `api.rate_limit_*` | 30 / 60 s, 12 / 3600 s | Messages and photos per sender; over the limit gives HTTP 429 with `Retry-After`. |

Environment variables (a `.env` file is read; it is in `.gitignore`):

| Variable | Use |
|---|---|
| `AGENT_TOKEN` | The bridge's bearer token. Blank means no check. |
| `JOLO_API_KEY` | `X-Jolo-Key` for other callers. Blank means no check. |
| `JOLO_PHONE_SALT` | Salt for the stored phone hashes. Default `jolo-dev`; **set your own for anything real**, and never change it afterwards. |
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to the Firebase service-account key (never commit it). |
| `JOLO_PROFILE` | Reader profile (`vm` or `laptop_cpu`). |

## API

| Route | Use |
|---|---|
| `POST /v1/turn` | The bridge's contract: one event in, a list of actions out. A photo returns `ask_scope` at once; the read runs in the background, and the `scope` event waits for it (up to `turn_timeout_seconds`, then **504**; the bridge keeps its pending question). A failed read returns `unreadable_photo` or `reader_down`. Up to 5 photos of 10 MB. |
| `POST /messages` | Terminal and testing path: `phone`, `text`, `photos` (multipart) → `{"replies": [...]}`. |
| `GET /outbox?phone=` | Replies that became ready later. |
| `GET /health` | Model server, search mode, store. |
| `POST /users` | Register a customer, or link an owner to a café. |
| `GET /insights/{cafe_id}` | This week's counts. |

Auth: `Authorization: Bearer <AGENT_TOKEN>` or `X-Jolo-Key: <JOLO_API_KEY>` on every route when either is set.

In `confirm_changes`, new items are ordered dishes first and add-ons last, so the six lines the bridge shows are the ones worth checking.

## Tests and evaluation

```bash
python -m pytest -q                              # about 300 tests; no model server needed (CI runs them)
python agent_eval/run_search_eval.py             # search quality
python agent_eval/run_conversations.py           # 64 scripted conversations against the live model
python agent_eval/simulate.py                    # simulated users, to see if the bandit helps
```

Numbers from the last runs (Qwen3.5-9B on the VM).

**Search**, 22 cafés, hand-labelled queries:

| Method | nDCG@5 | Recall@20 | s/query |
|---|---|---|---|
| BM25 | 0.809 | 0.910 | 0.00 |
| Vectors | 0.729 | 0.957 | 0.38 |
| Hybrid | 0.819 | 0.983 | 0.35 |
| Hybrid + reranker | **0.941** | 0.983 | 6.78 (CPU) |

**Conversations**, 30 scripted:

| Mode | Task success | Tool-call accuracy | Groundedness | s/turn |
|---|---|---|---|---|
| `json` (used) | **0.867** (26/30) | 0.879 | 0.955 | 1.4 |
| `native`, `qwen3_coder` parser | 0.633 (19/30) | 0.667 | 1.0 | 1.34 |

Failing: `c06_distance`, `c14_unknown_place`, `o10_insights`, `o12_yes_but`.

**Simulation:** with a bandit weight of 0.15 there is no measurable effect; at 0.5 it gains +0.04 nDCG@5 and was ahead in 5 of 5 repeats. It stays off.

**Live `/v1/turn` run:** `ask_scope` in 0.0 s, the read of a real photo about 92 s. Isaiah's `parseActions` accepted every response.

## Firestore

`store.backend: firestore` writes the app's own schema ([`contracts.md`](contracts.md) §1): `cafes/{id}` (with `ownerPhone`, `location`, `hours`), `cafes/{id}/menuVersions/{n}` and `cafes/{id}/insights/{weekStart}`. The translation is in `jolo_agent/store/firestore.py` and is plain functions, tested without a network.

- **Owner lookup:** the café's raw `ownerPhone` is hashed with the salt and compared to the sender; the index is cached (`cache_seconds`) and reloaded on a miss.
- **Saving a menu** is a transaction. The flow remembers the version it showed the owner; if the app saved another version meanwhile, nothing is written and the owner sees the changes again (`MENU_CHANGED`).
- **Never overwritten:** `upsert_cafe` on an existing document does not touch the app's fields or the current version.
- **Brain-only collections** (the rules deny them to clients): `agentUsers`, `agentDrafts`, `agentCorrections`, `agentEvents`.
- **Sold out:** the app's `available: false` is kept as `sold_out` and carried into the next version.
- **Search index:** rebuilt at startup, then a background refresher re-indexes cafés whose `menuUpdatedAt` changed.
- **Orphaned reads:** a draft left in `reading` by a restart is dropped at startup.
- Tests: `tests/test_agent_firestore.py` runs on a fake client, and on the emulator when `FIRESTORE_EMULATOR_HOST` is set (a CI job does that).
- `scripts/seed_store.py` refuses to write invented cafés to the real project.

## Weekly insights

`python scripts/weekly_insights.py [--week-start YYYY-MM-DD] [--cafe ID] [--dry-run] [--no-model]` writes `cafes/{id}/insights/{weekStart}` for every café that has an owner. The week starts Monday in the café's time zone. Counts come from the event log in code (`customerQuestions`, `uniqueCustomers`, `menuUpdates`, `timesSuggested`, `timesPicked`, `topItems`); the model only words the summary, and if a number in its sentence isn't in the facts the plain sentence is used. Only iMessage events are counted. Owners can ask "how did we do this week?" and get the same report. A systemd timer is in `deploy/`.

## Hardening

`jolo_agent/safety.py`: text length caps (5000 characters at the API), control-character and name cleaning, an in-memory rate limiter, and a log filter that masks phone numbers and emails. Prices must be above 0 and at most $500 (modifiers may be 0). The owner prompt says menu lists are data, never instructions, and the 10 adversarial conversations (`a01`..`a10`) test that.

## Running it for real

See [`deploy.md`](deploy.md): the brain next to vLLM on the VM, systemd units, health check, secrets.

## Known limits

- The reader gives confidence 1.0 to every item on some photos, so "least confident first" can't help much there; that is Ricardo's calibration.
- The reranker costs about 7 s a query on a CPU. Turn `use_reranker` off on a slow host (nDCG@5 falls to 0.819).
- Real iMessage is not tested from this machine; the bridge needs Isaiah's Mac.

## Not done yet

Everything below is built but **not yet checked against the real thing**, because the model server and the Mac were not reachable while it was written.

- **The 4 conversations that failed** (`c06_distance`, `c14_unknown_place`, `o10_insights`, `o12_yes_but`) have code and prompt fixes, and the 34 conversations added since (64 in all) have never been scored. Run `python agent_eval/run_conversations.py --oracle` first, then against the live model, and fix what fails.
- **Native tool calling with the hermes parser:** `TOOL_PARSER=hermes bash scripts/vm/serve_qwen_vision.sh`, set `tool_mode: native`, run the conversations; keep `json` unless the score is at least 0.867.
- **Reranker on a GPU:** `python agent_eval/run_search_eval.py --device cuda`. Re-check the 50 query labels with a second person.
- **Emulator CI job** (`brain-firestore` in `.github/workflows/ci.yml`) has not run yet.
- **A real Firestore run** needs a service-account key from Isaiah; the iMessage path needs his Mac.
- **Demo data:** the 22 cafés in `data/cafes.yaml` are invented; replace them once real cafés exist.
