# Integration guide: connecting to the eyes

Bhavesh, Isaiah, this one is for you.

I finished the eyes as a Python function: a menu photo goes in, structured menu
data comes out. This page is the short list of what each of you does to use it.
The [README](../menu_reader/README.md) has the full details and the field-by-field reference;
[`menu-update-flow.md`](menu-update-flow.md) shows one menu update step by step.

## The picture in one minute

```
owner's photo --> your agent --> extract_menu(photo) --> MenuResult --> your agent --> database, reply
                                       |
                                       v  HTTP
                          Qwen3.5-9B on the GPU VM (vLLM, port 8000)
```

- `extract_menu()` is ordinary Python that runs **inside the agent's process**.
- It needs one thing from outside: the Qwen3.5-9B server on the GPU VM.
- It stores nothing and sends no messages. Saving the menu and talking to the owner are yours.

## What you need from me

- [ ] Access to this repo.
- [ ] The VM running, and its current public IP (it changes every time I start it).
- [ ] A way to reach the VM. I'm not passing my private key around: send me your **public** SSH key and I'll add it to the VM, or run the agent on the VM itself.

## Bhavesh: wire it into the agent

1. **Install it next to the agent.**

   ```bash
   git clone <this repo>
   cd eyemenureader
   python -m venv .venv
   source .venv/bin/activate          # Windows Git Bash: source .venv/Scripts/activate
   python -m pip install paddlepaddle==3.2.0 -i https://www.paddlepaddle.org.cn/packages/stable/cpu/
   python -m pip install -r requirements.txt
   python -m pytest -q                # needs no server; everything should pass
   ```

2. **Reach the model server.** With the server running on the VM (I start it with `bash scripts/vm/serve_qwen_vision.sh`), open a tunnel and leave it running:

   ```bash
   ssh -i <your key> -N -L 8000:localhost:8000 ubuntu@<VM IP>
   ```

   If the agent runs on the VM itself, skip the tunnel.

3. **Check it works before writing any agent code.**

   ```bash
   python scripts/warmup.py
   python scripts/read_photo.py path/to/any_menu.jpg
   ```

   The first prints `Server is up` and a short menu. The second prints every item and saves the full result to `output/<name>.json`. Open that file: it is exactly what your agent will receive.

4. **Call it from the agent.**

   ```python
   from menu_reader.config import load_config
   from menu_reader.pipeline import extract_menu
   from menu_reader.merge import merge_results

   config = load_config()                      # once, at start-up

   result = extract_menu(photo_bytes, current_menu=stored_menu, config=config)
   if not result.readable:
       ...                                     # result.reason says why
   menu = result.model_dump()                  # a plain dict
   ```

   - `photo_bytes` is the raw image file content. A file path works too.
   - `stored_menu` is what you saved last time for this café (`result.model_dump()` or just its `"items"`). Leave it out for a café's first photo.
   - Several photos of one menu: call `extract_menu()` on each **without** `current_menu`, then `merge_results(results, current_menu=stored_menu)`.

5. **Build these on your side. My part doesn't do them.**

   - [ ] **Run it off the message loop.** A read takes roughly 15 to 100 seconds and blocks.
   - [ ] **Confirm with the owner before saving.** The reader is good at prices and weak at size names and at telling decoration from menu items. Ask about the lowest-`confidence` items first.
   - [ ] **Never delete on `missing_from_photo`.** It only lists what the photo doesn't show. Ask "Is this your full menu, or just part of it?"
   - [ ] **Add `cafe_id` and store the result.** The eyes return no café identity and write to no database.
   - [ ] **Handle `readable: false`.** `model_error: ...` means the server or tunnel is down; anything else means the photo couldn't be used.

6. **Decide: one Qwen server or two.** Your agent model is also Qwen3.5-9B. The eyes' server speaks the OpenAI chat API on port 8000 with the model name `qwen3.5-9b`, thinking off and a 16,384-token context, so it may be able to serve the agent too. I haven't tested tool calling against it, or whether the embedding and reranker models fit on the same GPU beside it.

## Isaiah: what the interface needs to handle

You don't call the eyes directly; the agent does. These are the moments your side shows.

_Isaiah: all six are built in the bridge and the owner app, against a stand-in agent. What the agent has to send for each is in [`contracts.md`](contracts.md) §2 and §3; the wording is in [`conversation-design.md`](conversation-design.md)._

- [x] **A wait message.** Send something like "Reading your menu…" as soon as a photo arrives. The answer comes 15 to 100 seconds later.
- [x] **Pass the photo through untouched.** Hand the agent the original image bytes (HEIC, JPG, PNG and WebP all work). Don't shrink or screenshot it: small text is what the reader struggles with.
- [x] **A confirmation step.** Show the owner what was found and let them fix it, for example "Found 24 items. Cortado $4.50?" Plan for corrections to size names in particular.
- [x] **Several photos in a row.** Owners often send a menu in parts. The agent merges them, so the interface should let them send more before confirming.
- [x] **Two failure messages.** "I couldn't read that photo, can you send a clearer one?" and "I can't read menus right now, try again in a minute."
- [x] **For the dashboard:** every item has `section`, `item`, `category` (`drink`, `food` or `modifier`), a list of `prices` (each with an optional `size` and a `usd` number, possibly empty) and a `confidence` from 0 to 1. `add_ons`, `variants` and `tags` exist but come back empty for now.

## What to expect from the results

I measured this on 25 web photos, against answers I typed up by hand and haven't fully double-checked.

| | 17 photos I built it on | 8 photos I held back and read once |
| --- | --- | --- |
| Items found and matched (F1) | 86.4% | 65.4% |
| Price right, when the item is found | 94.6% | 98.1% |
| Seconds per photo | 49.9 | 33.5 |

- **Trust the prices more than the size names.** When a menu prints sizes once as a column heading ("12oz / 16oz"), they often come back as "small / large".
- **Expect an occasional item that isn't one**: a flavor word or wall decoration.
- **`confidence` is a ranking aid, not a probability.** It can't catch a lost price or a wrong name.
- **I haven't tested real phone photos yet.** Try the photo you plan to demo before the demo.

## Before the demo

- [ ] I start the VM and the server; one of us opens the tunnel.
- [ ] Run `python scripts/warmup.py` a few minutes before. The first read after a start is the slow one.
- [ ] Read the demo photo once with `scripts/read_photo.py` and look at the result.
- [ ] Stop the VM afterwards. It costs about $1/hour while it runs.

## Questions to settle together

1. Where does the agent run: on the VM (no tunnel) or on the Mac that hosts iMessage (tunnel)?
2. One Qwen server for both the agent and the eyes, or two?
3. Is the confidence check worth 10 to 30 extra seconds per photo? It can be switched off with `config["confidence"]["ppocr_check"] = False`.
4. Where do owner corrections get stored, so they can train a better reader later?
