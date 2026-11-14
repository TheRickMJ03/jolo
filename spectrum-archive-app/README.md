# spectrum-archive-app

A temporary [Spectrum](https://photon.codes/docs/spectrum-ts) app. It receives messages from the terminal, iMessage, Telegram and WhatsApp Business, replies through one `respond()` function (JOLO's onboarding and menu flow via the team agent, an LLM agent, or an echo), archives every content message as Parquet (in S3 or a local folder), and serves a small authenticated API for querying the archive and sending messages.

It is built to be cheap to run and easy to tear down completely.

```
provider ──┐
provider ──┼─→ app.messages (stream) ──┐
provider ──┘                           ├─→ respond() ─→ agent loop ─→ LLM ⇄ tools
            app.webhook() (HTTP) ──────┘     │   │
                                             │   └─→ sendAndArchive() ─→ space.send
                                             └─→ archive(row) ─→ buffer + JSONL spool
                                                                    │ every 30s / 500 rows
                                                                    ▼
                       {root}/messages/dt=YYYY-MM-DD/hour=HH/part-….parquet  (ZSTD)
                       {root} = s3://BUCKET/PREFIX  or  data/archive
```

## Prerequisites

- Node **20.6+**, which `process.loadEnvFile` needs. This was tested on Node 22.18.
- Nothing else for the terminal. Other providers need:

| Provider | Needs | Project required? |
|---|---|---|
| `terminal` | nothing | no (projectless) |
| `imessage` | `PROJECT_ID`, `PROJECT_SECRET` | **yes** |
| `telegram` | `TELEGRAM_BOT_TOKEN` **and** project creds | **yes** (inbound runs through Fusor) |
| `whatsapp-business` | `WA_TOKEN`, `WA_NUMBER_ID`, `WA_SECRET` | no (direct mode) |

- For S3 archiving, an AWS account and two sets of credentials:
  - **App credentials**, scoped by [`iam-policy.json`](iam-policy.json). They can only list, read, write and delete under the prefix. These go in `.env`.
  - **Admin credentials**, scoped by [`iam-admin-policy.json`](iam-admin-policy.json). Use them only for `archive:setup` and `archive:teardown`.

  Both files use the placeholder `YOUR_BUCKET` and the default prefix `spectrum-archive`. Replace them before attaching the policies:

  ```bash
  sed -i '' 's/YOUR_BUCKET/my-bucket-name/g' iam-policy.json iam-admin-policy.json
  ```

## Setup order

1. Create `.env` from the example and fill in only what you need. Every variable is optional.

   ```bash
   cp .env.example .env
   ```

2. Install dependencies. Every version is pinned exactly.

   ```bash
   npm install
   ```

3. **Only if you use S3:** set `S3_BUCKET` (and optionally `S3_PREFIX`, `AWS_REGION`, `ARCHIVE_EXPIRE_DAYS`) in `.env`, then run setup **with the admin credentials**. One way to keep them out of `.env` is an AWS profile:

   ```bash
   AWS_ACCESS_KEY_ID= AWS_SECRET_ACCESS_KEY= AWS_PROFILE=spectrum-admin npm run archive:setup
   ```

   Setup creates the bucket if it is missing, blocks all public access, turns on default SSE-S3 encryption, and adds a lifecycle rule. The rule expires objects under `S3_PREFIX/` after `ARCHIVE_EXPIRE_DAYS` and cleans up abandoned multipart uploads after one day. It keeps any lifecycle rules that are not its own, and it is safe to re-run.

4. Start the app:

   ```bash
   npm start
   ```

   The startup log lists which features are on, and for each one that is off it says why. This covers the providers, the archive destination, the webhook server and the API.

   The first S3 run downloads DuckDB's `httpfs` extension, plus the `aws` extension if you left the keys blank. Local mode downloads nothing.

## Using it

In the terminal TUI, type `hello` and you get back `echo: hello`. The slash commands are `/ping`, `/whoami`, `/help` and `/reset`.

- In the TUI, the space ids are `chat-1`, `chat-2`, and so on.
- With piped stdin (non-TTY), the space id is `terminal`.

Set `LLM_MODEL` (and `LLM_BASE_URL`/`LLM_API_KEY`) to switch from echo to the agent. Its tools are:

| Tool | What it does |
|---|---|
| `get_current_time` | Current date and time |
| `calculate` | Arithmetic, accepted only if it matches a whitelist |
| `conversation_info` | Facts about the current conversation |
| `save_note`, `list_notes`, `forget_note` | Durable notes that outlive the transcript |
| `search_archive` | Searches the **current** conversation's archive only, with no way to pick another space. Its output is marked as untrusted data. |

`npm run models` lists the models your key can reach. `npm run memory` and `npm run memory:clear` show or wipe transcripts and notes. Stop the app before `memory:clear`, or it writes its in-memory state back.

### The JOLO conversation (`AGENT_URL`)

This is JOLO's iMessage voice. With `AGENT_URL` set, `respond()` hands every message, photos included, to [`src/jolo/conversation.ts`](src/jolo/conversation.ts):

1. **Onboarding (first contact).** JOLO asks "Are you an owner or a user?". A user is pointed at the app. An owner sends their name, business and location in one message, and the bridge writes their café (`cafes/owner-{digits}`) so the app shows it when that number signs in. Signing up again updates those three fields and never resets the menu. The answers are kept per conversation, and `/reset` starts over.

   Where the café is written: `FIRESTORE_EMULATOR_HOST` set → the local emulator. Blank → the real project through the Firebase Admin SDK, with `JOLO_SERVICE_ACCOUNT` (a key file) or Application Default Credentials. See [`src/jolo/link-cafe.ts`](src/jolo/link-cafe.ts).
2. **Everything after that goes to Bhavesh's agent** via `POST {AGENT_URL}/v1/turn`. The bridge sends:
   - the text and photos (the original file as base64, never resized; `image/*` only, at most 5, each up to 10 MB)
   - "Reading your menu…" to the owner first, whenever there's a photo, because a read takes 15 to 100 seconds
   - the sender's handle, taken from iMessage itself, never from the message text
3. **The agent answers with actions**, and the bridge picks the wording:
   - `ask_scope` → "Is this your full menu, or just part of it?"
   - `confirm_changes` → "Found 2 new items and 3 price changes. Cortado now $4.75?"
   - `menu_updated` → "Your menu is updated ✅"
   - `unreadable_photo` → "I couldn't read that photo. Can you send a clearer one?"
   - `reader_down` → "I can't read menus right now. Try again in a minute."
   - …and so on.

   While a question is pending, the owner's reply is parsed as the answer ("Just part of it" → `partial`, "Yes, all correct" → yes). A reply with a fix in it ("no, the cortado is 4.50") goes to the agent as a `correction` and the updated summary comes back. An unclear reply gets asked again without calling the agent. A photo sent while an update is open joins it, so a menu can be sent in parts.

The wording is in [`src/jolo/copy.ts`](src/jolo/copy.ts) and [`../docs/conversation-design.md`](../docs/conversation-design.md). The contract is in [`../docs/contracts.md`](../docs/contracts.md). Commands and archiving work the same as before, and every JOLO message is archived.

**Try it before the real agent exists.** The stub plays one café, "Barbara's", owned by `terminal-user`. Start it in one terminal:

```bash
npm run agent:stub
```

Then point the bridge at it in another:

```bash
AGENT_URL=http://127.0.0.1:8788 npm start
```

In the terminal TUI, drag a photo in to play the owner. Ask "What's on the menu at Barbara's?" to play a customer. To own the café from your real iMessage number, start the stub with `STUB_OWNER_HANDLES=+19085551234`.

### The webhook

Set `WEBHOOK_PORT` to start the HTTP server. It serves:

- `POST {WEBHOOK_PATH}` for inbound deliveries
- `GET {WEBHOOK_PATH}` for Meta's handshake
- `GET /health`

> **The webhook URL goes in the Photon dashboard, not in Meta's callback URL.** `app.webhook()` only understands native Spectrum JSON and Fusor protobuf envelopes, both sent *by Spectrum Cloud*. If you point Meta's callback URL straight at this server, no messages will be delivered. The `GET` handshake (`hub.challenge`, checked against `WA_VERIFY_TOKEN`) exists **only so that Meta will agree to save a URL at all**.

Set `SPECTRUM_WEBHOOK_SECRET` from the Photon dashboard. These are the responses I observed:

| Request | Secret set | Response |
|---|---|---|
| Unsigned POST | yes | `400` |
| Bad signature | yes | `401` |
| Any signed POST | no | `500` (the SDK logs that no `webhookSecret` is configured) |

Deliveries are at-least-once. `respond()` drops a message id it has seen in the last 10 minutes before it archives or replies.

## HTTP API

The API runs on the same server as the webhook, so it needs **both** `WEBHOOK_PORT` and `API_KEY`. Every route needs the header `X-API-Key: $API_KEY`, which is compared in constant time.

- Errors are JSON: `{"error": "..."}`.
- Status codes: `400` bad input, `401` bad or missing key, `404` unknown route or space, `405` wrong method, `413` body too large.
- Every request value reaches DuckDB as a bind parameter.

```bash
export API_KEY=...            # same value as in .env
export B=http://localhost:8787
```

**`GET /health`** needs no key. It returns liveness, the archive buffer size, the last flush time and the last flush error.

```bash
curl -s $B/health
```

**`GET /api/messages`** returns messages newest first. All filters are optional:

- `space_id`, `platform`, `direction`
- `since`, `until`: ISO dates, applied to `recorded_at`
- `limit`: default 50, values above 500 are capped to 500

Unflushed rows are merged in, so results are real-time.

```bash
curl -s -H "X-API-Key: $API_KEY" "$B/api/messages?limit=20"
curl -s -H "X-API-Key: $API_KEY" "$B/api/messages?platform=telegram&direction=inbound&since=2026-11-01&until=2026-11-10T23:59:59Z"
```

**`GET /api/spaces`** returns each distinct space with its platform, message count and last message time.

```bash
curl -s -H "X-API-Key: $API_KEY" $B/api/spaces
```

**`GET /api/spaces/:spaceId/messages`** returns a thread in chronological order: the latest `limit` messages, default 1000, maximum 5000. URL-encode the id.

```bash
curl -s -H "X-API-Key: $API_KEY" "$B/api/spaces/chat-1/messages"
curl -s -H "X-API-Key: $API_KEY" "$B/api/spaces/$(node -p 'encodeURIComponent(process.argv[1])' 'any;-;+15551234567')/messages"
```

**`POST /api/send`** sends a text message and archives it with `source = "api"`.

```bash
curl -s -H "X-API-Key: $API_KEY" -H 'content-type: application/json' \
  -d '{"space_id":"chat-1","text":"hello from the API"}' $B/api/send
```

It can only send to **spaces that have messaged the app since it started**; any other space gets `404`. This is a registry of the `Space` objects that `respond()` has seen. spectrum-ts does expose per-platform `<provider>(app).space.get(id)`, but resolving arbitrary ids would let anyone holding the API key message any number or chat. The registry also needs no platform narrowing.

**`POST /api/flush`** forces a flush and returns the row and file counts.

```bash
curl -s -X POST -H "X-API-Key: $API_KEY" $B/api/flush
```

## The archive

- **Schema.** Defined once in `src/archive/schema.ts` and enforced on every write. An unknown column, a wrong type, a null in a required column or a bad enum value means the row is dropped and logged.

  | Column | Type | Notes |
  |---|---|---|
  | `archive_id` | VARCHAR | UUIDv4 |
  | `provider_message_id` | VARCHAR | nullable |
  | `space_id` | VARCHAR | |
  | `platform` | VARCHAR | |
  | `direction` | VARCHAR | `inbound` or `outbound` |
  | `sender_id` | VARCHAR | nullable |
  | `content_type` | VARCHAR | |
  | `text` | VARCHAR | nullable; set only for text content |
  | `source` | VARCHAR | `stream`, `webhook`, `agent` or `api` |
  | `provider_timestamp` | TIMESTAMPTZ | nullable; the SDK's `Message.timestamp` |
  | `recorded_at` | TIMESTAMPTZ | our clock, UTC |

- **What is not stored.** Signals (`read`, `typing`, `unsend`, `edit`) and our own echoes are skipped. Raw payloads, tokens and signatures are never stored.
- **Append-only.** Nothing ever rewrites a file to update a row. Readers dedupe on `archive_id`.
- **Durability.** `archive()` appends to the buffer **and** to `data/spool/messages.jsonl` before it returns. The spool is replayed on boot and trimmed only after a write succeeds. A failed write is retried 3 times with backoff, then stays in the spool. The app keeps answering messages throughout.
- **Shutdown.** Ctrl+C (SIGINT), SIGTERM and `beforeExit` flush the memory store and the archive. Each flush is isolated, so one failing does not skip the other. Even after `kill -9`, the spool still has every unflushed row.

### `npm run archive:query`

Runs ad-hoc SQL. `messages` is a view over the Parquet files plus the spool, with the hive columns `dt` and `hour`, which are NULL for rows still in the spool. `spool` holds only the unflushed rows.

```bash
npm run archive:query -- "SELECT platform, direction, count(*) AS n FROM messages GROUP BY ALL ORDER BY n DESC"
```

```bash
npm run archive:query -- "SELECT recorded_at, space_id, sender_id, text FROM messages WHERE text ILIKE '%invoice%' ORDER BY recorded_at DESC LIMIT 20"
```

```bash
npm run archive:query -- "SELECT dt, hour, count(*) AS n FROM messages WHERE dt >= DATE '2026-11-01' GROUP BY ALL ORDER BY ALL"
```

```bash
npm run archive:query -- "SELECT space_id, count(*) FILTER (WHERE direction = 'inbound') AS received, count(*) FILTER (WHERE direction = 'outbound') AS sent FROM messages GROUP BY ALL"
```

```bash
npm run archive:query -- "SELECT content_type, count(*) FROM messages WHERE text IS NULL GROUP BY ALL"
```

### `npm run archive:compact -- YYYY-MM-DD`

Merges each hour's small files for that day into a single file. It deletes the originals only after the new file's row count and schema match. It is safe to run while the app is up.

## Cost notes

The app makes no network calls of its own. Local mode is free, and the only cloud costs come from S3:

- **Storage.** Parquet with ZSTD is small. Each file has about 3 KB of fixed overhead (a 9-row test file was 2.9 KB); after that, short chat messages cost on the order of 100–200 bytes each. This is an estimate, not a measurement at scale. A million messages is well under 1 GB, about $0.02 per month on S3 Standard. The lifecycle rule deletes everything after `ARCHIVE_EXPIRE_DAYS` (14 by default).
- **Requests.**
  - One PUT per partition per flush, so a busy hour at the default 30s interval is up to 120 PUTs, about $0.0006.
  - Every API query, and every `search_archive` call, LISTs the prefix and GETs the matching files.
  - `archive:compact` cuts down the number of files.
  - Raise `ARCHIVE_FLUSH_INTERVAL_MS` to write fewer, larger files.
- **Transfer.** Run in the bucket's region where you can: S3 to the internet costs about $0.09/GB, but this data is tiny.
- **The LLM** is whatever your provider charges. `LLM_MAX_STEPS` (default 5) caps the model calls per message.

## Full teardown

1. Stop the app (Ctrl+C) so it flushes and releases the spool.
2. Delete the archive.
   - **S3:** run with the admin credentials. Without `--yes`, it only reports what it would delete.

     ```bash
     AWS_ACCESS_KEY_ID= AWS_SECRET_ACCESS_KEY= AWS_PROFILE=spectrum-admin npm run archive:teardown -- --yes
     ```

     It deletes every object and version under `S3_PREFIX/`, then deletes the bucket if that left it empty. If the bucket holds anything else, the bucket is kept.
   - **Local:** the same command deletes `data/archive/messages` and the spool file.
3. Delete what lives outside this script; it prints this list when it finishes:
   - **Photon / Spectrum Cloud project** at <https://app.photon.codes>: delete it, or rotate `PROJECT_SECRET`, and remove the webhook URL.
   - **Telegram bot:** `@BotFather` → `/deletebot`, or `/revoke` the token.
   - **WhatsApp Business** in Meta for Developers: the app, the test or phone number, the webhook subscription and the token.
   - **AWS IAM:** the users or roles and access keys you made from the two policies.
4. Delete the local files:

   ```bash
   rm -rf .env data node_modules
   ```

## Tests

```bash
npm test
```

The tests need no credentials, network or AWS. Each test file gets its own temp archive and never reads `.env`. They cover:

- the `respond()` guards and dedupe
- the JOLO conversation end to end against the stub agent over HTTP: onboarding, the wait message, the owner's scope and yes/no flow, corrections, several photos of one menu, both reader failures, a customer question, `not_owner`, the agent being down, photo limits
- the reply parsers (scope, yes/no, role, name) and the change summary
- the writer's schema, path, spool replay and failure handling
- reader merging, filters and ordering
- history trimming
- the tools, including `search_archive` scoping
- API auth, limits and send behavior

`npm run typecheck` runs `tsc` over `src`, `scripts` and `test`.
