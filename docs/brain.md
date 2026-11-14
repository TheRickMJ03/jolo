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
| `store.backend` | `memory` | `memory` is `data/store.json`; `firestore` uses the service-account key in `GOOGLE_APPLICATION_CREDENTIALS` (or `FIRESTORE_EMULATOR_HOST`). **Not yet translated to the app's schema**; see "Not done yet". |
| `api.host`, `api.port` | `127.0.0.1`, `8080` | Use `0.0.0.0` only with a key or token set. |
| `api.turn_timeout_seconds` | 280 | How long `/v1/turn` waits for a photo read; the bridge gives up at 300 s. |
| `api.callback_url` | `null` | Late `/messages` replies are posted here; otherwise poll `/outbox`. |
| `reads.workers` | 2 | Photos read at the same time. |
| `confirm.items_per_message` | 5 | Items the owner is asked to check at once. |
| `search.*` | | Index folder, models, `use_embeddings`, `use_reranker`, candidates, `max_miles`, and the `bandit` (off). |

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
python -m pytest -q                              # 213 tests; no model server needed (CI runs them)
python agent_eval/run_search_eval.py             # search quality
python agent_eval/run_conversations.py           # 30 scripted conversations against the live model
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

## Known limits

- The reader gives confidence 1.0 to every item on some photos, so "least confident first" can't help much there; that is Ricardo's calibration.
- The reranker costs about 7 s a query on a CPU. Turn `use_reranker` off on a slow host (nDCG@5 falls to 0.819).
- Real iMessage is not tested from this machine; the bridge needs Isaiah's Mac.

## Not done yet

- **Firestore as the source of truth.** The bridge and the app read Firestore; the brain still runs on the JSON store. Next: a `FirestoreStore` that writes `cafes/{id}` and `menuVersions/{n}` in the schema of [`contracts.md`](contracts.md) §1, then rebuilding the search index from it.
- The weekly insights job (`insights/{weekStart}`).
- The four failing conversations, input limits and rate limiting, and running the brain on the VM next to vLLM.
