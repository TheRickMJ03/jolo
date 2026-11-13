# JOLO responsibilities

I updated my part (the eyes) to show what I actually built and have working.
Bhavesh's and Isaiah's parts are the same as in our original plan.

```mermaid
flowchart LR
    subgraph ISAIAH["🗣️ ISAIAH · Voice and Face"]
        direction TB
        I1["<b>iMessage connection</b><br/>receive photos and texts, send replies<br/><i>Photon iMessage Kit · TypeScript · runs on a Mac</i>"]
        I2["<b>Conversation design</b><br/>onboarding: name, owner or customer<br/>#quot;Full menu or part of it?#quot;<br/>confirmation texts"]
        I3["<b>JOLO app</b><br/>login with phone number<br/>owner dashboard: menu, edits, insights<br/><i>Expo · React Native · Firebase Auth · Firestore</i>"]
        I4["<b>Design and product</b><br/>UI/UX, logo, colors<br/>user stories, business model"]
        IS1["🔴 <b>Photon</b><br/>Agents in iMessage track"]
        IS2["🔴 <b>Salesforce · Capital One</b><br/>small-business owner tools<br/><i>possible fit · check prize criteria</i>"]
    end

    subgraph BHAVESH["🧠 BHAVESH · Brain"]
        direction TB
        B1["<b>Agent</b><br/>understands requests, calls tools, writes replies<br/>grounding check: no facts from memory<br/><i>Qwen3.5-9B · tool calling</i>"]
        B2["<b>Tools the agent calls</b><br/>find_cafe_by_phone · extract_menu<br/>get_menu · save_menu_version · search_cafes<br/><i>Python functions</i>"]
        B3["<b>Data and search</b><br/>Firestore = source of truth: cafés, menu versions<br/>search index rebuilt from Firestore<br/><i>BM25 + Qwen3-Embedding-0.6B<br/>Qwen3-Reranker-0.6B · LanceDB</i>"]
        B4["<b>Learning from usage</b><br/>reranker fine-tuning, bandit, simulated users<br/><i>LoRA · Thompson sampling</i>"]
        B5["<b>Model serving</b><br/>hosts everyone's models<br/><i>vLLM or Ollama · AWS g6.2xlarge · L4 24 GB</i>"]
        B6["<b>Owner insights</b><br/>weekly counts, LLM writes the summary"]
        BS1["🔴 <b>Amazon</b><br/>models served on AWS EC2"]
        BS2["🔴 <b>LangChain</b><br/>agent loop and tools"]
        BS3["🔴 <b>D. E. Shaw</b><br/>measured ranking gains, rigor<br/><i>possible fit · check prize criteria</i>"]
    end

    subgraph RICARDO["👁️ RICARDO · Eyes"]
        direction TB
        R1["<b>Intake and preprocessing</b><br/>opens HEIC, WebP, JPG, PNG<br/>limits the size, enlarges small photos<br/><i>pillow-heif · OpenCV</i>"]
        R2["<b>Read the menu</b><br/>the model looks at the photo and lists every item<br/>one short line per item, thinking mode off<br/><i>Qwen3.5-9B with vision, FP8 build · vLLM</i>"]
        R3["<b>Validate</b><br/>lines to structured items<br/>price formats, sizes, a price is never invented<br/><i>Pydantic</i>"]
        R4["<b>Confidence</b><br/>a second read of the same photo on the CPU<br/>items it also sees score higher<br/><i>PP-OCRv6 · RapidFuzz</i>"]
        R5["<b>Compare and merge</b><br/>new · changed · missing vs current menu<br/>several photos of one menu into one result<br/><i>RapidFuzz</i>"]
        R6["<b>Evaluation</b><br/>877-row hand-made ground truth, 25 photos<br/>dev/test split by café, scoring harness, 71 unit tests<br/>item F1: 86.4% dev · 65.4% held-out test"]
        RS1["🔴 <b>Scale AI</b><br/>hand-labeled ground truth and evaluation"]
        RS2["🔴 <b>Amazon</b><br/>AWS GPU serves the vision model"]
        R1 --> R2 --> R3 --> R4 --> R5
    end

    I1 <-->|"messages + photos"| B1
    I3 <-->|"reads and edits Firestore"| B3
    B2 -->|"photo + current menu"| R1
    R5 -->|"menu JSON + changes"| B2
    B5 -.->|"hosts the model"| R2

    classDef ricardo fill:#E1F5EE,stroke:#0F6E56,color:#085041
    classDef bhavesh fill:#EEEDFE,stroke:#534AB7,color:#3C3489
    classDef isaiah fill:#FAEEDA,stroke:#854F0B,color:#633806
    classDef sponsor fill:#FCEBEB,stroke:#A32D2D,color:#791F1F,stroke-width:2px

    class R1,R2,R3,R4,R5,R6 ricardo
    class B1,B2,B3,B4,B5,B6 bhavesh
    class I1,I2,I3,I4 isaiah
    class IS1,IS2,BS1,BS2,BS3,RS1,RS2 sponsor
```

## What changed in my part

| Original box | Now | Why |
| --- | --- | --- |
| Intake and preprocessing: HEIC, rotation, blur, perspective, contrast | Opens the photo, limits its size, enlarges small photos | Enlarging is the step that helped. I wrote the perspective fix, contrast boost and blur score too, but they're switched off: they didn't help on my dev photos, and I never set a blur threshold. |
| Find the menu (SAM 3) | Removed | I never ran it. My photos are tightly framed, so there was nothing to crop. |
| Read the menu (GLM-OCR, compared with PaddleOCR-VL-1.6, PP-OCRv6, Qwen3.5-9B) | Qwen3.5-9B reads the photo directly | I tried GLM-OCR first and it scored 61.6% item F1 on dev, against 86.4% for Qwen on the photo. I never ran PaddleOCR-VL. PP-OCRv6 moved to the confidence step. |
| Validate and compare | Split into Validate, Confidence, and Compare and merge | Each is its own module. Merging several photos of one menu is new. |
| Evaluation: 877-row verified ground truth, comparison table | Same data, with measured results | I made the ground truth by hand and haven't fully double-checked it. I measured two setups on dev, and ran only the one I chose on the held-out test photos. |
| Vision training (synthetic menus, Qwen3.5-4B LoRA) | Removed | I didn't get to it. |

## Notes on the arrows

- **The agent calls two functions:** `extract_menu(photo, current_menu)` for one photo and `merge_results(results, current_menu)` for several photos of one menu. Only `extract_menu` is in Bhavesh's tool list above; I added `merge_results` later.
- **"Hosts the model":** right now the Qwen3.5-9B server runs on my AWS VM, and I start it with `scripts/vm/serve_qwen_vision.sh`. Bhavesh, we still need to agree whether it moves under your model serving. Your agent model is also Qwen3.5-9B, so one server may be able to do both jobs; I haven't tested that.
- **I took out the arrow from vision training to the database**, because there is no training yet. Owner corrections are still worth storing for later.

See [`integration-guide.md`](integration-guide.md) for how to connect, [`menu-update-flow.md`](menu-update-flow.md) for the step-by-step flow, and the [README](../README.md) for the full reference.
