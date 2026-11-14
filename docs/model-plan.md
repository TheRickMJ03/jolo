# Open-Source Model Plan: HackPrinceton 2026

Nov 9, 2026 · @Bhavesh
Ricardo here. I updated the menu-reading parts of Bhavesh's plan after building and testing the reader. Wherever a note below says "I", that's me. Everything about the agent, retrieval and the flywheel is Bhavesh's original text.

## Update from Ricardo: what my menu-reading results changed

**The menu reader is now one model: Qwen3.5-9B looking at the photo.** SAM 3, GLM-OCR and PaddleOCR-VL are not in my pipeline. It scored 86.4% item F1 on the 17 photos I built it on and 65.4% on 8 photos I held back and read once at the end. When it finds an item, the price is right about 95 to 98% of the time.

| | Original plan | What I built | Why |
| --- | --- | --- | --- |
| Crop | SAM 3, prompt "menu board" | No crop | Our photos are tightly framed; a simple text-box crop kept 73 to 92% of the image, so there was nothing for SAM 3 to remove. I never ran it. |
| Reader | GLM-OCR, photo straight to JSON | Qwen3.5-9B (FP8 build) on the photo | GLM-OCR alone ignored the schema (F1 22 to 32% on 3 photos). GLM-OCR text plus Qwen structuring reached 61.6% F1: on dense menus GLM-OCR looped, duplicated columns and made up prices. |
| Output format | JSON, constrained decoding | One short line per item, parsed by code | JSON took 179 s per photo on hard menus; lines take about 40 s |
| Second opinion | PaddleOCR-VL-1.6 | PP-OCRv6 on the CPU | Gives a confidence score with no second GPU model |
| Fine-tuned Qwen3.5-4B | Planned | Not started | I ran out of time; still open |
| Synthetic menus | 500+ | None | I didn't get to it |
| Real photos | 40+ menus | 25 web photos, with ground truth I made by hand (877 rows, not fully double-checked) | |

What I measured on dev (17 photos):

| Setup | Item F1 | Price exact match | Valid output | Seconds per photo |
| --- | --- | --- | --- | --- |
| GLM-OCR, schema extraction (laptop CPU, 3 photos) | 22 to 32% | 0 to 90% | 67 to 100% | 95 to 459 |
| GLM-OCR text, then Qwen3.5-9B structures it | 61.6% | 83.8% | 94.1% | 96.7 |
| **Qwen3.5-9B end to end (chosen)** | **86.4%** | **94.6%** | **100%** | **49.9** |
| GLM-OCR with SAM 3 crop | not run | | | |
| PaddleOCR-VL-1.6, then Qwen3.5-9B | not run | | | |
| Fine-tuned Qwen3.5-4B | not run | | | |
| Frontier API | not run | | | |

Held-out test (8 photos, chosen setup only, read once): item F1 65.4%, recall 70.6%, precision 61.0%, price exact match 98.1%, 33.5 s per photo. The plan asked for every setup on the test photos. I only ran the one I chose, so there is no frontier-model comparison to show judges.

**Known limits** (details in `menu_reader/README.md`):
- Size names printed as a column heading ("12oz / 16oz") are often lost and come back as "small / large". This is most of the gap between dev and test.
- Decoration and flavor words can come back as items. Both held-out trap checks failed.
- The confidence score is a ranking aid, not a probability, and misses structural errors.
- I haven't tested real phone photos; everything so far is web images.

**Bhavesh, what this means for the rest of your plan:**
- **The agent and the menu reader are now the same model.** One vLLM server with Qwen3.5-9B and vision could serve both. I run it with thinking off, a 16,384-token context and the FP8 build (`RedHatAI/Qwen3.5-9B-FP8-dynamic`). I haven't tested tool calling against that server.
- **The memory estimate needs redoing.** I took GLM-OCR and SAM 3 out of the table below, and I ran the reader with vLLM allowed 90% of the L4's 24 GB. I haven't measured whether the embedding and reranker models fit beside it; the allowance would have to come down.
- **Reading takes 15 to 100 seconds per photo**, over the 10-second iMessage target in the risk table. The agent should send "Reading your menu…" first and call the reader off the message loop.
- **The owner check in step 5 matters more than planned.** The reader is good at prices and weak at size names and decor, so confirm with the owner before saving, lowest confidence first.
- **The flywheel signal "owner corrects a price"** still works, but there is no fine-tuned reader to feed yet.
- **How to call it:** `extract_menu(photo, current_menu=None)` and `merge_results([...])`; see "Connecting to the pipeline" in `menu_reader/README.md`.

## Summary

*I revised the menu-reading sentences in this summary.*

Run JOLO on three open-weight models: Qwen3.5-9B reads menu photos and is also the agent, and Qwen3-Embedding-0.6B plus Qwen3-Reranker-0.6B handle retrieval. PP-OCRv6 runs on the CPU as a confidence check for menu reading. All are Apache 2.0. The original plan had five models; I dropped SAM 3 (cropping) and GLM-OCR (reading) after testing.

Fine-tune the reranker on user feedback; that loop is the flywheel. I haven't started the planned fine-tune of a small vision model on menu photos. The numbers we have for judges are menu-extraction accuracy on our own photos (86.4% item F1 on the photos I built the reader on, 65.4% on photos I held back) and ranking quality before and after feedback rounds. There is no comparison against a frontier model.

Nobody has measured whether the models fit together on one 24 GB GPU. I ran the menu reader alone with vLLM allowed 90% of the L4's memory. Confirm the fit on our actual hardware before the event.

## Project and ML scope

JOLO is an iMessage agent that connects coffee lovers and café owners: customers text it to find cafés, owners text it photos of their menus, and every interaction improves the shared café data. The ML layer has to turn messy photos into clean data, answer questions with evidence, learn from usage, and run on our own hardware.

| ML component | Job in JOLO | Pitch line it backs | Team owner (from overview) |
| --- | --- | --- | --- |
| Menu segmentation | Find the menu board in a cluttered photo | | Not built: my test photos were tightly framed, so I never ran the SAM 3 step |
| Menu reading (photo to structured items) | Turn a menu photo into items: section, name, sizes, prices, category, with a confidence score and a comparison against the current menu | “Map apps guess. JOLO reads the actual menu on the wall.” A read takes 15 to 100 seconds, not “seconds”. | Ricardo (Qwen3.5-9B with vision; see `menu_reader/README.md`) |
| Agent LLM | Understand the request, call tools, explain each pick | “You don’t search JOLO, you just ask it.” | Bhavesh |
| Retrieval (RAG): embeddings + reranker | Find the right cafés and menu items for a request | “It checks hours, distance, and reviews, then tells you why.” | Bhavesh |
| Flywheel learning | Use clicks, picks and owner edits to improve ranking and extraction | “Every search, every photo makes JOLO smarter.” | Ricardo, Bhavesh |
| Local serving | Run all models on our own machine | “Our AI runs on our own hardware.” | Bhavesh |

Open question: who owns the weekly owner insights model, and does it need anything beyond the agent LLM?

## Open-weight model shortlist

Each component gets one primary model and one or two alternatives to test against it. Benchmark numbers are vendor- or publisher-reported, so treat them as a starting point and re-test on our own menu photos and queries.

| Component | Model | Size | License | Why |
| --- | --- | --- | --- | --- |
| Segmentation · primary | [SAM 3](https://github.com/facebookresearch/sam3) | 848M | [SAM License](https://roboflow.com/model-licenses/segment-anything-3): commercial use allowed, some use bans, gated download | **Not used:** I never ran it, my test photos needed no cropping. Original reason: A text prompt like “menu board” finds and crops every board in a cluttered photo. SAM 3.1 (Mar 2026) mainly speeds up video tracking, which we don’t need |
| Menu reading · primary | [GLM-OCR](https://arxiv.org/html/2603.10910) | 0.9B | MIT ([Roboflow](https://roboflow.com/blog/best-open-source-ocr-models)) | **I tried it and dropped it:** alone it ignored our schema; as a transcriber feeding Qwen it reached 61.6% item F1, and on dense menus it looped and made up prices. Original reason: Extracts fields straight into a strict JSON schema we define; paper shows a menu-board example; runs on vLLM, SGLang and Ollama |
| Menu reading · alternative | [PaddleOCR-VL-1.6](https://arxiv.org/abs/2606.03264) | 0.9B | Apache 2.0 | **I never ran it.** Original reason: Top OmniDocBench v1.6 score (96.3%); tested on skewed, warped and screen-photographed pages. Outputs Markdown, so an LLM must structure it |
| Menu reading · light fallback | [PP-OCRv6](https://roboflow.com/blog/best-open-source-ocr-models) | 1.5M–34.5M | Apache 2.0 | **I use it as the confidence check:** it reads the same photo on the CPU, and items it also sees score higher. Original reason: Scene text on signs and labels; runs on a CPU. Text and boxes only, no structure |
| Agent LLM · primary | [Qwen3.5-9B](https://vdf.ai/blog/best-local-llm-for-agents-tool-calling/) | 9.7B, about 5.6 GB at 4-bit | Apache 2.0 | Tool calling (BFCL-V4 66.1) and [native image input](https://artificialanalysis.ai/articles/qwen3-5-small-models), so it is also our end-to-end menu-reading baseline. **It is now the menu reader itself**, which I serve with vLLM as the FP8 build (`RedHatAI/Qwen3.5-9B-FP8-dynamic`), not 4-bit |
| Agent LLM · alternative | [gpt-oss-20b](https://vdf.ai/blog/best-local-llm-for-agents-tool-calling/) | 21B (3.6B active), 12.1 GB at 4-bit | Apache 2.0 plus usage policy | Native function calling and structured outputs; text only |
| Agent LLM · small alternative | [Gemma 4 E4B](https://happymining.eu/blogs/articles/meilleur-llm-local) | about 6.6 GB | Apache 2.0 | Reads images; fits 8 GB machines if hardware is tight |
| Agent LLM · stretch and teacher | [Qwen3.6-35B-A3B](https://vdf.ai/blog/best-local-llm-for-agents-tool-calling/) | 36B (3B active), 20.4 GB at 4-bit | Apache 2.0 | Stronger agent on a 24–32 GB GPU; also labels training data for the small models |
| Embeddings · primary | [Qwen3-Embedding-0.6B](https://qwenlm.github.io/blog/qwen3-embedding) | 0.6B | Apache 2.0 | Instruction-aware, 32K context, 100+ languages; 4B and 8B sizes if recall is short |
| Reranker · primary | [Qwen3-Reranker-0.6B](https://qwenlm.github.io/blog/qwen3-embedding) | 0.6B | Apache 2.0 | Small enough to fine-tune on feedback in minutes; MTEB-R 65.8 |
| Fine-tuning base · vision | [Qwen3.5-4B](https://unsloth.ai/docs/models/qwen3.5/fine-tune) | 4B, about 10 GB for bf16 LoRA | Apache 2.0 | **I haven't started this.** Student model for photo-to-JSON; Unsloth has vision notebooks. Qwen3.5-2B (about 5 GB) if GPU is small |

Left out: Chandra OCR 2 has the best handwriting support (useful for chalkboards) but its license restricts commercial use. Llama 4 Scout needs about 67 GB, which is too large to run locally.

## Plan per component

One rule covers every model: the LLM never states a fact on its own. Prices, hours and distances come from the database or a tool, and the model only explains them.

&#91;embedded content: JOLO model architecture · owner path, customer path, feedback loop\]

The owner path fills the database, the customer path only reads from it, and the dashed feedback retrains the reranker and the menu reader.

### 1. Menu reading: photo to structured data

*I rewrote this section to describe what I built. Steps 5 and 6 are the agent's and are still the plan.*

Schema delivered, one record per menu item (the agent adds `cafe_id`):

```json
{"section": "Espresso", "item": "Cortado", "category": "drink",
 "prices": [{"size": "8 oz", "usd": 4.50}],
 "add_ons": [], "variants": [], "tags": [], "confidence": 1.0}
```

`category` is `drink`, `food` or `modifier`. `add_ons`, `variants` and `tags` are in the schema but the current reader leaves them empty. Each result also carries `readable`, `reason`, an overall `confidence`, `hours`, `changes` (when a current menu is given) and `timings`.

Pipeline:

1. The owner texts a photo. The reader opens it, limits its size, and enlarges small photos to 2000 pixels on the long side.
2. No crop. (SAM 3 was planned here; I never ran it.)
3. Qwen3.5-9B looks at the photo and lists every item, one short line per item, with thinking mode off. Decoding is not constrained; code parses the lines.
4. Code checks the result: prices parse as money and are never invented, sizes are attached, and PP-OCRv6 reads the same photo on the CPU to give each item a confidence score. When the current menu is passed in, new items, price changes and items missing from the photo are reported. Several photos of one menu can be merged.
5. JOLO texts the owner a check: “Found 24 items. Cortado $4.50?” Every correction becomes training data. *(Agent; planned.)*
6. Items go into the database and the search index. *(Agent; planned.)*

Data:

- **Real photos:** 25 web photos of café menus from 22 cafés, split by café into 17 for building and 8 held out. No photos taken on site yet, and none from a phone at an angle or with glare.
- **Labels:** 877 rows I made by hand in a spreadsheet. I haven't double-checked every row.
- **Synthetic menus:** I didn't make any.

The comparison table. The first three rows are from the 17 photos I built on; I ran only the setup I chose on the 8 photos I held back:

| Setup | Item F1 | Price exact match | Valid output | Seconds per photo |
| --- | --- | --- | --- | --- |
| GLM-OCR, schema extraction (laptop CPU, 3 photos) | 22 to 32% | 0 to 90% | 67 to 100% | 95 to 459 |
| GLM-OCR text, then Qwen3.5-9B structures it | 61.6% | 83.8% | 94.1% | 96.7 |
| **Qwen3.5-9B end to end (chosen)** | **86.4%** | **94.6%** | **100%** | **49.9** |
| Qwen3.5-9B end to end, held-out photos | 65.4% | 98.1% | 100% | 33.5 |
| GLM-OCR with SAM 3 crop first | not run |  |  |  |
| PaddleOCR-VL-1.6, then Qwen3.5-9B structures it | not run |  |  |  |
| Fine-tuned Qwen3.5-4B | not run |  |  |  |
| Frontier API (reference only) | not run |  |  |  |

Fine-tuning: I haven't started. The original idea stands if there is time: a bf16 LoRA on Qwen3.5-4B with Unsloth, on synthetic plus real training photos. Unsloth advises against 4-bit QLoRA for Qwen3.5. Export to GGUF for Ollama or a merged 16-bit model for vLLM, and keep the same chat template at inference.

### 2. Agent LLM

Qwen3.5-9B runs a tool loop: read the request, call tools, then reply with 2–3 picks and one reason each.

- **Tools:** `search_cafes(query, location, filters)`, `get_menu(cafe_id)`, `get_hours(cafe_id)`, `distance(origin, cafe_id)`, `get_reviews(cafe_id)`.
- **Grounding check:** every price, hour or distance in the reply must appear in a tool result; otherwise regenerate.
- **Latency:** turn reasoning mode off for chat turns. Artificial Analysis found the small Qwen3.5 models spend many tokens thinking.
- **Memory:** the same source measured an 80–82% hallucination rate on knowledge questions for the 4B and 9B, so the agent must never answer café facts from memory.
- **Owner insights:** compute weekly counts in SQL; the LLM only writes the summary.
- **Evaluation:** 30 scripted conversations, scored on tool-call accuracy, task success, groundedness and median latency.

### 3. Retrieval: embeddings and reranker

1. Index one document per café (name, vibe, hours, summary) and one per menu item, linked to its café.
2. Search with keyword (BM25) and Qwen3-Embedding-0.6B together; keep the top 50.
3. Filter in code: open now, within distance.
4. Qwen3-Reranker-0.6B orders the rest; the top 5 go to the agent.

Store everything locally in LanceDB, SQLite with sqlite-vec, or Postgres with pgvector. Evaluate on 50 hand-written queries with graded relevance labels, using Recall@20 and nDCG@5.

### 4. Flywheel: learning from usage

There will be no real users during a 36-hour hackathon, and full reinforcement learning is risky in that time. Build learning from feedback instead, and prove it with simulated users.

| Signal | What it trains |
| --- | --- |
| A customer picks one of the suggested cafés, or replies “going” | Reranker: picked café ranked above the others shown |
| A customer ignores every suggestion or asks again | Reranker: those cafés become negatives for that query |
| An owner corrects an extracted price | Menu-reading model: photo plus corrected JSON |
| A customer texts a menu photo | Fresher menu data and new training photos |

- **Reranker updates:** LoRA fine-tune Qwen3-Reranker-0.6B on the preference pairs after each round.
- **Exploration:** a contextual bandit (Thompson sampling) sometimes shows newer cafés, so they collect feedback too. This is the honest reinforcement-learning piece to pitch.
- **Stretch:** preference-tune (DPO) the agent’s replies.
- **Demo:** simulate about 200 users with LLM personas (taste, location), run 3–5 feedback rounds, and chart nDCG@5 on held-out queries after each round. Use a different model for the personas than for ranking, and label the chart as simulated.

## Infrastructure and privacy

Serve every model on one machine behind one OpenAI-compatible endpoint, so the agent code can swap models by changing a config line. Training can run on a rented cloud GPU while everything users touch stays local.

| Model | Runtime | Memory, rough estimate |
| --- | --- | --- |
| Qwen3.5-9B (agent and menu reader) | Ollama or vLLM. The menu reader runs it on vLLM as the FP8 build with vision, thinking off, 16,384-token context | about 5.6 GB at 4-bit (estimate). FP8 use not measured: vLLM was allowed 90% of the 24 GB |
| ~~GLM-OCR (menu reading)~~ dropped | | |
| PP-OCRv6 (menu-reading confidence check) | PaddleOCR on the CPU | no GPU memory |
| Qwen3-Embedding-0.6B | sentence-transformers or vLLM | about 1.5 GB |
| Qwen3-Reranker-0.6B | sentence-transformers or vLLM | about 1.5 GB |
| ~~SAM 3 (segmentation)~~ dropped | | |

Total is roughly 12–16 GB plus working memory, which is why the summary says 24 GB. Measure it on day one.

*Ricardo: we no longer need GLM-OCR and SAM 3. My menu reader uses the Qwen3.5-9B row (FP8 build on vLLM, not 4-bit), and I haven't measured its real memory use next to the other models.*

Hardware options:

- **NVIDIA GPU with 24 GB:** best fit. vLLM gives fast serving and JSON-constrained output, and SAM 3 runs natively.
- **Apple silicon Mac with 32 GB or more:** runs the LLMs through Ollama or MLX, and is also the Mac that hosts the iMessage bot. SAM 3 officially needs CUDA; a community MLX port exists but is untested by us.
- **Fine-tuning:** Qwen3.5-4B LoRA needs about 10 GB of GPU memory. Without a local NVIDIA card, rent one (Colab, Modal or AWS) and say so in the pitch.
- **Versions:** Unsloth notes Qwen3.5 needs transformers v5 and a recent vLLM. Pin versions once the stack works.

Privacy:

- Photos, messages and the database stay on our disk. Hash phone numbers.
- Delete raw photos after extraction unless the owner agrees to let them train the model.
- No model call leaves the machine. Use Photon’s local [iMessage Kit](https://github.com/photon-hq/imessage-kit), which reads Messages on our own Mac. Photon’s hosted gateway routes messages through their servers, which would weaken the “our own hardware” claim.

## Timeline

The four days before November 13 decide whether the 36 hours go to building or to setup. Check HackPrinceton’s rules first: data and test sets are usually fine to prepare early, but code often must be written at the event.

Before the event:

- [ ] Request SAM 3 access on Hugging Face (downloads are gated)
- [ ] Run Qwen3.5-9B, GLM-OCR and the Qwen3 embedding and reranker models on our machine; record memory use
- [ ] Agree on the menu JSON schema with Ricardo and Isaiah
- [ ] Photograph 40+ menus at 10+ cafés, with permission
- [ ] Write 50 test queries with relevance labels and 30 test conversations
- [ ] Line up a GPU for fine-tuning
- [ ] Confirm HackPrinceton’s rules on pre-event work

During the event, workstreams overlap as shown below. The fine-tuning run goes in the background while the agent is built.

&#91;embedded content: ML workstreams across the 36 hacking hours\]

Serving and menu reading must work end to end by hour 6, because every other workstream depends on it.

## Risks and fallbacks

The biggest risk is chalkboard handwriting, because no shortlisted OCR model publishes results on chalkboard menus. GLM-OCR’s handwritten-form score (86.1) is the closest signal, so test with real photos this week.

*Ricardo: the first row's fallback (Qwen3.5-9B end to end, owner confirms by text) is now my main path, because GLM-OCR read dense menus badly. I settled the SAM 3 row by skipping the crop. The iMessage latency risk is real: a read takes 15 to 100 seconds.*

| Risk | Early sign | Fallback |
| --- | --- | --- |
| Handwritten chalkboards read badly | Low item F1 on chalkboard photos | Qwen3.5-9B end to end; the owner confirms prices by text; fine-tune on chalkboard photos |
| Models don’t fit in memory | Out-of-memory errors, slow swaps | Gemma 4 E4B or Qwen3.5-4B as the agent; run embeddings on the CPU |
| SAM 3 access is slow or there is no NVIDIA GPU | No checkpoint by Thursday | Skip cropping; GLM-OCR has its own layout step. Show the crop as an ablation only if it helps |
| Fine-tuning doesn’t beat the baseline | Fine-tuned F1 at or below the base model | Report it honestly; pitch the smaller model’s speed and cost instead |
| Replies take too long over iMessage | Over 10 seconds per answer | Reasoning mode off; send “Reading your menu…” first; use a smaller model |
| Agent calls tools wrongly | Failed scripted conversations | Fewer tools, JSON-constrained calls; try gpt-oss-20b |
| Judges question the flywheel | “Where are the users?” | Show simulated rounds, clearly labeled, and the owner-correction loop working live |
| License questions | “Can you ship this?” | Everything is Apache 2.0 or MIT except SAM 3, whose license allows commercial use with some banned uses; list it in the README |

## Sources

- [SAM 3 repository](https://github.com/facebookresearch/sam3), Meta
- [Segment Anything 3 license summary](https://roboflow.com/model-licenses/segment-anything-3), Roboflow
- [Best Open-Source OCR Models in 2026](https://roboflow.com/blog/best-open-source-ocr-models), Roboflow, updated Oct 5, 2026
- [GLM-OCR technical report](https://arxiv.org/html/2603.10910), arXiv
- [PaddleOCR-VL-1.6 paper](https://arxiv.org/abs/2606.03264), arXiv, June 2026
- [Best Local LLM for Agents and Tool Calling](https://vdf.ai/blog/best-local-llm-for-agents-tool-calling/), VDF, Oct 6, 2026
- [Best local LLM: Gemma 4, Qwen 3.8, gpt-oss](https://happymining.eu/blogs/articles/meilleur-llm-local), Oct 2026
- [Qwen3.5 small models](https://artificialanalysis.ai/articles/qwen3-5-small-models), Artificial Analysis, Mar 5, 2026
- [Qwen3 Embedding and Reranker](https://qwenlm.github.io/blog/qwen3-embedding), Qwen
- [Qwen3.5 fine-tuning guide](https://unsloth.ai/docs/models/qwen3.5/fine-tune), Unsloth
- [iMessage Kit](https://github.com/photon-hq/imessage-kit), Photon
