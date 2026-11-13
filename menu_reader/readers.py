"""Readers: one function per reading setup.

Each takes (image, config, photo_id) and returns a reply:
    {"text": JSON as the model wrote it, "finish_reason": ..., "seconds": model time}

A reader does no cleaning. Turning raw output into trusted menu items is
validate.py's job, so a cached reply stays useful when validation changes.
"""

import json

from menu_reader.model_client import ask_about_image, ask_text

# ---------- GLM-OCR on its own ----------

# GLM-OCR's model card documents exactly one way to ask for structured data
# ("information extraction"): this Chinese instruction line, followed by a JSON
# template with empty values. The line means "Output the information in the
# image in the following JSON format:". Free-form instructions are not documented.
GLM_OCR_INSTRUCTION = "请按下列JSON格式输出图中信息:"

# Its documented prompt for plain transcription.
GLM_OCR_TEXT_PROMPT = "Text Recognition:"

MENU_TEMPLATE = {
    "hours": "",
    "items": [
        {
            "section": "",
            "item": "",
            "category": "",
            "prices": [{"size": "", "usd": ""}],
            "add_ons": [{"name": "", "usd": ""}],
            "variants": [""],
            "tags": [""],
        }
    ],
}

# A flat template: one row per price, like a ground-truth row.
FLAT_TEMPLATE = {
    "items": [
        {"section": "", "item": "", "size": "", "price": ""}
    ],
}


def glm_ocr_schema_prompt():
    return GLM_OCR_INSTRUCTION + "\n" + json.dumps(MENU_TEMPLATE, ensure_ascii=False, indent=2)


def glm_ocr_flat_prompt():
    return GLM_OCR_INSTRUCTION + "\n" + json.dumps(FLAT_TEMPLATE, ensure_ascii=False, indent=2)


def read_glm_ocr_schema(image, config, photo_id=None):
    """GLM-OCR, photo straight to our nested JSON template."""
    return ask_about_image(image, glm_ocr_schema_prompt(), config, "glm_ocr",
                           config["reader"]["max_tokens"], photo_id)


def read_glm_ocr_flat(image, config, photo_id=None):
    """GLM-OCR with the flat template. validate.build_items() merges the rows into items."""
    return ask_about_image(image, glm_ocr_flat_prompt(), config, "glm_ocr",
                           config["reader"]["max_tokens"], photo_id)


# ---------- two steps: transcribe, then structure ----------

def transcribe_glm_ocr(image, config, photo_id=None):
    """GLM-OCR's main job: copy out all the text in the photo."""
    return ask_about_image(image, GLM_OCR_TEXT_PROMPT, config, "glm_ocr",
                           config["reader"]["max_tokens"], photo_id)


MENU_RULES = """\
Turn it into JSON with exactly this shape:

{
  "hours": "opening hours as written, or null",
  "items": [
    {
      "section": "the heading the item is listed under, or null",
      "item": "the item name",
      "category": "drink" or "food" or "modifier",
      "prices": [{"size": "size as written, or null", "usd": 4.50}],
      "add_ons": [{"name": "add-on name", "usd": 0.75}],
      "variants": ["flavors that share this item's price"],
      "tags": []
    }
  ]
}

Rules:
- Copy names exactly as written, including misspellings. Do not translate. On a bilingual menu, use the name once, not once per language.
- One entry per menu item. Descriptions and ingredient lists are not items, and are not part of the name: "Affogato: a scoop of ice cream in espresso" is the item "Affogato".
- Every entry needs a name: "item" is never null. Leave out anything you cannot name.
- A line of ingredients or a sentence under an item name ("Bread, Tuna, Carrot, Mayo" or "Double espresso shot + hot water") describes that item. It is never an item or a modifier. If a price stands at the end of such a line, it is the price of the item named above it.
- The OCR often puts a price on its own line, under the name it belongs to.
- A heading, then one price, then a list of names: every name in the list is an item at that price, and the heading is their "section", not an item ("Smoothies", "5.25", "Mango", "Banana" is two items at 5.25).
- Only when a heading has a price and nothing listed under it is the heading itself the item ("HOUSE MATCHA" then "$7" is the item "HOUSE MATCHA" at 7).
- Never invent a price. If the text shows no price for an item, "prices" is []. Never write 0 for a missing price.
- Sizes and weights are not part of the name and a price is never a size: "Honey 50g .50" is the item "Honey" at 0.5.
- "usd" is a number: "$4.50" is 4.5, "4" is 4, "50¢" is 0.5, "+.50" is 0.5.
- An item with several sizes has one "prices" entry per size, with the size as written (for example "Sm", "12oz", "Large"). A dash or "X" in a size column means that size is not offered: leave it out.
- A quantity deal like "3 for 9" is one "prices" entry with the size "3 for" and usd 9. The first number is a count, not a price.
- Several prices separated by "/" with no size names ("$4.50/$5.50") are sizes, smallest first: two prices are "small" and "large", three are "small", "medium" and "large".
- A price range written with a dash, like "$6-9", becomes two entries with sizes "min" and "max".
- A price printed next to a section heading applies to every item in that section.
- A list of flavors sharing one price is ONE item, with the flavors in "variants".
- "category": "drink" for anything you drink, "food" for anything you eat, "modifier" for extras and substitutions (extra shot, oat milk, add bacon). List modifiers as their own items with category "modifier"; use "add_ons" only for an extra offered for one specific item.
- Leave out addresses, phone numbers, websites, slogans and anything that is not on the menu.
- Reply with the JSON only, compact: no indentation and no line breaks.
"""

STRUCTURE_PROMPT = (
    "Below is the text of a café or restaurant menu, copied from a photo by an OCR model.\n"
    + MENU_RULES
    + "\nMenu text:\n"
)

# For a model that looks at the photo itself.
PHOTO_PROMPT = (
    "This is a photo of a café or restaurant menu.\n"
    + MENU_RULES
    + "- Leave out items that are crossed out.\n"
    + "- Cents are sometimes printed as small raised digits: read them as cents.\n"
    + "- If you cannot read a price clearly, leave it out. Do not guess digits.\n"
)


def read_glm_ocr_then_structure(image, config, photo_id=None):
    """Step 1: GLM-OCR copies out the text. Step 2: a language model fills our schema.

    The structurer never sees the photo, only the text.
    """
    transcript = transcribe_glm_ocr(image, config, photo_id)
    structured = ask_text(STRUCTURE_PROMPT + transcript["text"], config, "structurer",
                          config["reader"]["structurer_max_tokens"], photo_id)
    return {
        "text": structured["text"],
        "finish_reason": structured["finish_reason"],
        "seconds": transcript["seconds"] + structured["seconds"],
        "transcript": transcript["text"],
        "transcript_cut_off": transcript["finish_reason"] == "length",
    }


# ---------- one model, photo straight to our schema ----------

def read_qwen_photo(image, config, photo_id=None):
    """Qwen3.5 looks at the photo and fills our schema. No OCR step.

    The server must be started WITHOUT --language-model-only (scripts/vm/serve_qwen_vision.sh).
    """
    return ask_about_image(image, PHOTO_PROMPT, config, "qwen_vision",
                           config["reader"]["structurer_max_tokens"], photo_id)


# The same job with a much shorter answer: one line per item instead of JSON.
# All of an item's prices sit on its line, so they can't drift to a neighbour.
# Writing the answer is what takes the time, so fewer characters means a faster read.
PHOTO_LINES_PROMPT = """\
This is a photo of a café or restaurant menu. List everything on it that can be ordered, one line per item, in exactly this format:

section | item | prices | category

- section: the heading the item is listed under. Empty if there is none. A heading is never an item.
- item: the name of the drink or dish itself, exactly as written, including misspellings. No description, no ingredients, and no size in the name ("Fries (Small)" is the item "Fries" with the size "Small"). Do not translate. On a bilingual menu, write the name once, not once per language.
- prices: every price printed for this item, in the order printed, separated by ";".
  - When the menu names the sizes, write the size name in front of each price, copied exactly as printed: "SM 4.5; LG 5.25". Do not spell out or change a size name.
  - When size names are printed once, as a row above a group of prices ("Small  Medium  Large  Extra Large"), first write that row on its own line, exactly as printed: SIZES | Small; Medium; Large; Extra Large. Then write the prices of the items under it as numbers alone, in the same order. Write a new SIZES line for every group that has its own row of size names.
  - When the menu prints several prices and no size names anywhere ("$4.50/$5.50"), write the numbers alone: "4.5; 5.5".
  - Leave "prices" empty when no price is shown.
- A price is a number in dollars: "$4.50" is 4.5, "50¢" is 0.5. Cents are sometimes printed as small raised digits: read them as cents. Write only prices you can see. Never work out, guess or repeat a price that is not printed for that item, and never write 0. If you cannot read a price clearly, leave it out.
- category: drink for anything you drink, food for anything you eat, modifier for extras and substitutions (extra shot, oat milk, add bacon).

Rules:
- Every drink or dish with its own name gets its own line, even when several share one price printed at their heading.
- A plain list of flavors or add-ons at one price (syrups, milks, toppings) is a single line named by the label of the list ("Add Topping", "Syrups"). Do not list the flavors.
- A quantity deal like "3 for 9" is written "3 for 9" in "prices".
- A price range written with a dash, like "$6-9", is written "min 6; max 9".
- Leave out items that are crossed out, and addresses, phone numbers, websites, slogans and decoration.
- If opening hours are shown, start with one line: HOURS | the hours as written
- Reply with the lines only: no heading line, no explanations, no code fences.

Example of the format (not from this menu):
HOURS | 7am - 3pm
Coffee | Latte | 12oz 4.5; 16oz 5.25 | drink
Coffee | Drip | 2.5; 3 | drink
Coffee | Syrups | 0.75 | modifier
SIZES | Slice; Half; Whole
Pies | Apple | 4; 14; 26 | food
Pies | Cherry | 4.5; 15; 28 | food
Bakery | Croissant | 3 | food
Bakery | Soup of the Day | | food
"""


def read_qwen_photo_lines(image, config, photo_id=None):
    """Qwen3.5 looks at the photo and answers in the compact line format."""
    reply = dict(ask_about_image(image, PHOTO_LINES_PROMPT, config, "qwen_vision",
                                 config["reader"]["structurer_max_tokens"], photo_id))
    reply["format"] = "lines"   # tells pipeline.py which parser to use
    return reply


# name in config.yaml (reader.name) -> function
READERS = {
    "qwen_photo_lines": read_qwen_photo_lines,
    "qwen_photo": read_qwen_photo,
    "glm_ocr_schema": read_glm_ocr_schema,
    "glm_ocr_flat": read_glm_ocr_flat,
    "glm_ocr_then_structure": read_glm_ocr_then_structure,
}
