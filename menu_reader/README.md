# jolo-menu-reader

This is Ricardo's part of JOLO, the eyes: a photo of a menu goes in, structured menu data comes out.

```python
from menu_reader.pipeline import extract_menu
from menu_reader.merge import merge_results

result = extract_menu("menu.jpg")                            # a path or the image bytes
result = extract_menu(photo_bytes, current_menu=old_menu)    # also fills result.changes
whole = merge_results([result_a, result_b], current_menu=old_menu)   # one menu, several photos

result.model_dump()        # a plain dict, ready for JSON
```

It is a pure function. It never writes to a database, sends a message or
decides what a result means. That is the agent's job.

## How it works

1. **Intake**: opens the photo (HEIC, JPG, PNG, WebP) and limits its size.
2. **Preprocess**: enlarges small photos so the longest side is 2000 pixels.
3. **Read**: Qwen3.5-9B, served by vLLM on the GPU VM, looks at the photo and lists every item.
4. **Validate**: turns the model's answer into trusted items. A price is never invented: no clear price means no price.
5. **Confidence**: PP-OCRv6 reads the same photo on the CPU; items it also sees score higher.
6. **Compare**: only when `current_menu` is given.

## What comes back

```json
{
  "readable": true,
  "reason": null,
  "confidence": 0.87,
  "hours": "11am - closing",
  "items": [
    {
      "section": "Espresso",
      "item": "Cortado",
      "category": "drink",
      "prices": [{"size": "8 oz", "usd": 4.5}],
      "add_ons": [],
      "variants": [],
      "tags": [],
      "confidence": 1.0
    }
  ],
  "changes": {
    "new_items": [],
    "price_changes": [{"item": "Cortado", "size": null, "old_usd": 4.5, "new_usd": 4.75}],
    "missing_from_photo": []
  },
  "timings": {"intake": 0.1, "preprocess": 0.0, "crop": 0.0, "read": 14.2, "validate": 0.0, "confidence": 9.5}
}
```

What the agent needs to know:

- **`readable: false`** comes with a `reason` and no items:
  - `unreadable_file`: not an image we can open.
  - `blurry`: too blurred to read (only when a blur threshold is set in `config.yaml`).
  - `model_error: ...`: the model server didn't answer. The VM is off or the tunnel is closed.
  - `model_output_not_json`, `model_output_cut_off`: the model's answer was unusable or too long.
- **`category`** is `drink`, `food` or `modifier` (extras such as oat milk or an extra shot).
- **`prices`** is empty when the menu shows no price. Sizes are copied as printed (`"SM"`, `"12 oz"`). When a menu prints several prices with no size names, the sizes are `"small"`/`"large"` or `"small"`/`"medium"`/`"large"`. A range like "$6-9" is two prices with sizes `"min"` and `"max"`.
- **`confidence`** (0 to 1, per item and overall) is a ranking aid, not a probability: use it to decide which items to double-check with the owner first. 0.5 means the check was switched off.
- **`variants`, `add_ons` and `tags`** are part of the contract but the current reader leaves them empty. A list of flavors or add-ons at one price comes back as one item named by its label (for example "Syrups"), with category `modifier` when it is an extra.
- **`changes`** is filled only when `current_menu` is given. `current_menu` can be an earlier `MenuResult`, its dict, or a plain list of items (each needs `item` and `category`).
  - `missing_from_photo` lists items of the current menu that the photo doesn't show. The reader never treats them as removed: the photo may show only part of the menu. Ask the owner "Is this your full menu, or just part of it?"
  - In `price_changes`, `old_usd` is null for a size that is new and `new_usd` is null for a size that is gone.
  - Slightly different spellings of one name ("Capuccino", "Cappuccino") count as the same item.
- **Several photos of one menu**: call `extract_menu()` once per photo without `current_menu`, then `merge_results(results, current_menu=...)`.
- **Speed**: about 40 seconds per photo on the dev set, from 5 seconds for a short menu to about 90 for a very dense one, plus roughly 10 to 30 seconds for the confidence check on a laptop CPU.

## Measured results and known limits

I scored it against ground truth I made by hand (877 rows, 25 photos). I haven't double-checked every row.

| | Dev (17 photos I built the reader on) | Test (8 photos I read once at the end) |
| --- | --- | --- |
| Item F1 | 86.4% | 65.4% |
| Recall | 92.1% | 70.6% |
| Precision | 81.2% | 61.0% |
| Price exact match (on matched items) | 94.6% | 98.1% |
| Category accuracy | 97.7% | 95.7% |
| Seconds per photo | 49.9 | 33.5 |

The test number is the honest one, since I tuned the reader on the dev photos. What it shows:

- **Size names from a column heading are often lost.** On two test menus the prices were right but came back as `"small"`/`"large"` where the menu's heading says `12oz`/`16oz` or `single`/`double`. So `"small"`/`"large"` does not always mean the menu named no sizes. This is most of the gap between dev and test.
- **Decoration and flavors can come back as items.** Both test trap checks failed: wall decor reading "Latte" and a pastry flavor "Piña Colada" were returned as menu items.
- **Lists of toppings or options are sometimes returned one modifier per entry** instead of one item for the list.
- **When an item is found, its price is almost always right.**

Before acting on a result, the agent should confirm it with the owner, lowest confidence first.

I fixed two parsing bugs after the test run (four unnamed prices split into four items; a sub-heading column misread). The test score doesn't include those fixes, and I didn't re-run it.

### Open items

- When the reader misses a menu's size heading, my code still labels the prices small/large. It should leave the size empty instead of making up a label, and I need it to read size headings more reliably.
- Decoration and flavor words are sometimes returned as items.
- Lists of toppings or options are sometimes returned one modifier per entry.
- The confidence score is uncalibrated and cannot catch a lost price or a wrong name.
- I haven't fully verified the ground truth. About 15 rows where the reader disagreed the same way across several runs still need checking against the photos, mostly prices on minas_03 and coastcafe_16.
- I haven't tested real phone photos (angled, glare, background). Everything so far is web images.
- `add_ons`, `variants` and `tags` are always empty with the current reader.
- I haven't tested serving the menu reader and the agent from one Qwen3.5-9B server.
- I didn't build cropping a menu out of a cluttered photo, or training from owner corrections.

### What I tried first

| Setup | Dev result | Outcome |
| --- | --- | --- |
| GLM-OCR alone, photo to JSON (laptop CPU, 3 photos) | F1 22 to 32% | Ignored the schema, looped, invented sizes |
| GLM-OCR transcript, then Qwen3.5-9B structures the text | F1 61.6%, price match 83.8%, 96.7 s per photo | On dense photos GLM-OCR looped, duplicated columns and made up prices |
| Qwen3.5-9B on the photo, JSON answer (5 hard photos) | F1 85.0%, 179 s per photo | Accurate but too slow |
| Qwen3.5-9B on the photo, one line per item | F1 86.4%, price match 94.6%, 49.9 s per photo | Kept |

I left the GLM-OCR readers and the `laptop_cpu` profile in the code as a record of that comparison.

## Connecting to the pipeline (Bhavesh, Isaiah: start here)

There are two parts. The **model server** (Qwen3.5-9B on a GPU) does the reading.
The **pipeline** is plain Python that runs inside your own process, wherever the
agent runs, and talks to the server over HTTP.

### 1. Install the pipeline where the agent runs

```bash
git clone <this repo>
cd eyemenureader
python -m venv .venv
source .venv/bin/activate            # Windows Git Bash: source .venv/Scripts/activate
python -m pip install paddlepaddle==3.2.0 -i https://www.paddlepaddle.org.cn/packages/stable/cpu/
python -m pip install -r requirements.txt
python -m pytest -q                  # no model server needed; all tests should pass
```

Either run the agent from the repo root, or add the repo to `PYTHONPATH`, so
`import menu_reader` works.

### 2. Start the model server (on the GPU machine)

First time only, on the VM:

```bash
python3 -m venv ~/vllm-env
source ~/vllm-env/bin/activate
pip install -U pip vllm              # several GB
```

Every time, inside `tmux` (the instance costs about $1/hour; stop it when done):

```bash
bash scripts/vm/serve_qwen_vision.sh
```

It is ready when it prints `Application startup complete`. It serves an
OpenAI-compatible API on port 8000 with the model name `qwen3.5-9b`.

The agent's own LLM in the team plan is also Qwen3.5-9B. This server can answer
ordinary chat requests too (`POST /v1/chat/completions`, model `qwen3.5-9b`,
thinking mode off, 16,384-token context), so one server may be able to do both
jobs. I haven't tested the agent's tool calling against it yet.

### 3. Point the pipeline at the server

The pipeline reads the server address from `endpoint` in the `vm` profile of
`config.yaml` (default `http://localhost:8000/v1`).

- **Agent on the same machine as the server:** nothing to change.
- **Agent on another machine:** open an SSH tunnel and leave it running, so
  `localhost:8000` reaches the VM:

  ```bash
  ssh -i ~/.ssh/jolo_gpu_key.pem -N -L 8000:localhost:8000 ubuntu@<VM IP>
  ```

- **A different address:** edit `endpoint` in `config.yaml`, or set it in code:

  ```python
  from menu_reader.config import load_config
  config = load_config()
  config["endpoint"] = "http://10.0.0.5:8000/v1"
  ```

Check the connection and warm the server up before a demo:

```bash
python scripts/warmup.py                     # server check + one real read
python scripts/read_photo.py path/to/menu.jpg   # full result, saved to output/<name>.json
```

### 4. Call it from the agent

```python
from menu_reader.config import load_config
from menu_reader.pipeline import extract_menu
from menu_reader.merge import merge_results

config = load_config()          # load once, reuse for every call

# An owner texts one photo. photo_bytes is the raw file content from iMessage.
result = extract_menu(photo_bytes, config=config)

if not result.readable:
    if result.reason.startswith("model_error"):
        reply = "I can't read menus right now. Try again in a minute."
    else:
        reply = "I couldn't read that photo. Can you send a clearer one?"
else:
    menu = result.model_dump()      # plain dict: store it, send it, turn it into JSON
    reply = f"Found {len(result.items)} items."

# The café already has a menu in the database: ask what changed.
result = extract_menu(photo_bytes, current_menu=stored_menu, config=config)
result.changes.new_items            # ["Flat White"]
result.changes.price_changes        # [PriceChange(item="Cortado", size=None, old_usd=4.5, new_usd=4.75)]
result.changes.missing_from_photo   # ["Banana Bread"]  -> ask the owner, never delete on your own

# The owner sends several photos of one menu.
results = [extract_menu(photo, config=config) for photo in photos]
whole_menu = merge_results(results, current_menu=stored_menu)
```

Things to plan for:

- **It blocks.** One call takes roughly 15 to 100 seconds. Send "Reading your menu…" first and run the call off the message loop (a thread or a task queue).
- **It never raises for a bad photo or a dead server.** You get `readable: false` with a `reason`. It can still raise for a programming mistake, such as a `current_menu` whose items lack `item` or `category`.
- **`stored_menu`** can be the dict you saved from `result.model_dump()`, or just its `"items"` list.
- **Turn the confidence check off** if you don't want PaddleOCR on the agent machine: set `config["confidence"]["ppocr_check"] = False`. Every item then gets confidence 0.5, each call is 10 to 30 seconds faster, and PaddleOCR is never loaded.
- **The pipeline stores nothing.** No database, no files, no cache, unless a script turns the cache on.

Settings live in `config.yaml`. The default profile, `vm`, is the setup described here.

## Laptop setup (Windows, Git Bash, CPU only)

Run from the repo root.

```bash
# 1. Create and activate the venv (Python 3.12)
python -m venv .venv
source .venv/Scripts/activate
python -m pip install --upgrade pip

# 2. Install PaddlePaddle (CPU) from Paddle's own index
python -m pip install paddlepaddle==3.2.0 -i https://www.paddlepaddle.org.cn/packages/stable/cpu/

# 3. Install everything else
python -m pip install -r requirements.txt

# 4. Run the tests (no model server needed)
python -m pytest -q
```

## Evaluation

```bash
python scripts/run_reader.py --name my_run        # read every dev photo (cached after the first time)
python -m eval.run_eval --source file --predictions eval/cache/predictions/my_run.jsonl --name my_run
```

Each run writes `eval/results/<timestamp>_<name>/` with the metrics and every wrong or unmatched row.

## Rules

- I already read the 8 test photos once for the final score. Don't use them to tune the reader. The split is by café; see `eval/splits.yaml`.
- Model weights, caches, venvs, keys and tokens never go in Git.

## More documents

- [`docs/integration-guide.md`](../docs/integration-guide.md): the checklist for connecting the agent and the interface to the reader.
- [`docs/menu-update-flow.md`](../docs/menu-update-flow.md): one menu update, step by step, across the whole team.
- [`docs/team-responsibilities.md`](../docs/team-responsibilities.md): who owns what.
- [`docs/model-plan.md`](../docs/model-plan.md): the team's model plan, with a dated update on menu reading.
