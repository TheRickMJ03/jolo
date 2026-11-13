# How a menu update flows through JOLO

I updated the menu reader's steps (my lane) to show what I actually built. The
agent, database and iMessage steps are our original plan. I only added two
things there, the wait message and the unreadable-photo branch, because the way
my reader behaves makes them necessary.

```mermaid
sequenceDiagram
    autonumber
    actor O as 🏪 Owner
    box rgb(250,238,218) Isaiah · Voice and Face
        participant I as 🗣️ Photon iMessage
    end
    box rgb(238,237,254) Bhavesh · Brain
        participant B as 🧠 Agent
        participant D as 🧠 Firestore + search index
    end
    box rgb(225,245,238) Ricardo · Eyes
        participant R as 👁️ Menu reader
        participant Q as 👁️ Qwen3.5-9B on the GPU
    end
    actor C as ☕ Customer

    rect rgb(252,235,235)
        Note over I: 🔴 Sponsor: Photon<br/>Agents in iMessage
        Note over B,D: 🔴 Sponsors: Amazon (AWS serving)<br/>LangChain (agent loop)
        Note over R,Q: 🔴 Sponsors: Scale AI (eval)<br/>Amazon (AWS GPU)
    end

    Note over O,Q: Part 1 · Owner updates the menu
    O->>I: Photo + "update the menu"
    I->>B: Message, original photo file, owner's phone number
    B->>D: Look up café by phone number
    D-->>B: café_id + current menu (version 3)
    B->>I: Wait message
    I->>O: "Reading your menu…"

    par Ask the owner
        B->>I: Ask about scope
        I->>O: "Is this your full menu, or just part of it?"
        O->>I: "Just part of it"
        I->>B: Scope = partial
    and Read the photo at the same time
        B->>R: extract_menu(photo, current menu)
        R->>R: Open the photo, enlarge it if small
        R->>Q: Photo + instructions (HTTP, port 8000)
        Q-->>R: One line per item: section, name, prices, category
        R->>R: Validate: parse prices and sizes, never invent a price
        R->>R: Confidence: second read with PP-OCRv6 on the CPU
        R->>R: Compare with version 3
        R-->>B: Menu JSON + confidence per item + changes<br/>new items · price changes · items missing from photo
        Note over R,Q: Takes about 15 to 100 seconds
    end

    break Photo can't be used (readable = false, with a reason)
        B->>I: Ask for another photo, or say the reader is down
        I->>O: "I couldn't read that photo. Can you send a clearer one?"
    end

    opt Owner sends more photos of the same menu
        B->>R: extract_menu(photo) for each one, without the current menu
        B->>R: merge_results(all results, current menu)
        R-->>B: One menu JSON + changes for the whole menu
    end

    alt Full menu
        B->>B: Missing items = removed from menu
    else Just part of it
        B->>B: Ignore missing items · only add and change
    end

    B->>I: Summary of changes, least confident items first
    I->>O: "Found 2 new items and 3 price changes.<br/>Cortado now $4.75?"
    O->>I: "Yes, all correct"
    I->>B: Owner confirmed
    B->>D: Save version 4 in Firestore (current)<br/>keep version 3 as history
    B->>D: Re-index changed items
    Note over D: Owner dashboard in the app<br/>updates live from Firestore
    B->>I: Done
    I->>O: "Your menu is updated ✅"

    Note over C,D: Part 2 · A customer asks afterwards
    C->>I: "What's on the menu at Barbara's?"
    I->>B: Customer question
    B->>D: get_menu(café_id)
    D-->>B: Version 4 (the new one)
    B->>I: Reply with new prices
    I->>C: "Cortado $4.75, Latte $3.50… (updated today)"
```

## What changed from the original chart

| Step | Original | Now | Why |
| --- | --- | --- | --- |
| Inside the menu reader | "Crop, read, validate" | Open and enlarge, send to Qwen, validate, confidence, compare | I didn't build a crop step. The model, the confidence check and the comparison are separate steps in my code. |
| The model | Not shown | Qwen3.5-9B on the GPU, as its own participant | The reader is a Python function in the agent's process; the model is a separate server it calls over HTTP. Both have to be up. |
| What comes back | Menu JSON + comparison | Menu JSON + confidence per item + comparison | Each item now carries a confidence score from 0 to 1. |
| Wait message | Not shown | "Reading your menu…" before the read | A read takes about 15 to 100 seconds. |
| Unreadable photo | Not shown | A branch that stops the update and asks again | The reader returns `readable: false` with a reason when the photo can't be opened or the model server doesn't answer. It never fails silently. |
| Several photos | Not shown | Optional `merge_results` step | I built it so a menu photographed in parts becomes one result, and half a menu doesn't report the other half as missing. |
| Confirmation | Summary of changes | Summary, least confident items first | The reader is strong on prices and weaker on size names and on telling decoration from menu items, so the owner's check matters. |
| Photo handed to the agent | "photo" | "original photo file" | Small text is what the reader struggles with, so the photo should not be shrunk or screenshotted on the way. |

Part 2, the customer question, is unchanged: my reader isn't involved.

## Not in the chart because I haven't built it

- Cropping the menu out of a cluttered photo.
- Training from owner corrections. The agent can store them; nothing uses them yet.

See [`team-responsibilities.md`](team-responsibilities.md) for who owns what, and [`integration-guide.md`](integration-guide.md) for how to connect.
