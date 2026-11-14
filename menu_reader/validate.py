"""Turn raw model output into trusted menu items.

M3 version: the minimum needed for an end-to-end run. M4 adds every price
format, normalization, merging split photos and confidence.
"""

import json
import re

from menu_reader.schema import AddOn, MenuItem, Price

CATEGORIES = ("drink", "food", "modifier")
# Placeholder until M4: used when the model gives no usable category.
FALLBACK_CATEGORY = "food"


def parse_json_reply(text):
    """Find the JSON object in a model reply. Returns a dict, or None if there isn't one.

    Models often wrap JSON in ```json fences or add a sentence around it, so
    this takes everything from the first "{" to the last "}".
    """
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        parsed = json.loads(text[start:end + 1])
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def parse_lines_reply(text):
    """Read the compact one-line-per-item format. Returns a dict shaped like
    the flat JSON that build_items() accepts, or None if no line is usable.

        HOURS | 7am - 3pm
        section | item | prices | category | options

    One line per item. "prices" holds every price of the item, separated by
    ";", each with its size label if the menu prints one: "SM 8.5; LG 9.25".
    "options" (flavors sharing the price, separated by ";") may be missing.
    Lines that don't fit are skipped: a model sometimes adds a sentence or a fence.
    """
    hours = None
    item_lines = []          # [section, item, prices, category, options]
    sizes_by_section = {}    # section -> size names from a "SIZES | Small; Medium; Large" line
    pending_sizes = None     # a SIZES line waiting for the next item to tell us its section
    for line in text.splitlines():
        parts = [part.strip() for part in line.split("|")]
        if len(parts) == 2 and parts[0].upper() == "SIZES":
            # A row of size names printed above a group of prices. It belongs to
            # the section of the next item (or of the last one, if it comes at the end)
            # and names the unlabelled prices of every item in that section.
            names = [name.strip() for name in parts[1].split(";") if name.strip()]
            if names:
                pending_sizes = names
            continue
        if len(parts) in (6, 7) and parts[0] == "" and parts[-1] == "":
            if len(parts) == 6 and parts[3].lower() in CATEGORIES:
                parts = parts[:-1]       # no section, options, and a "|" at the end
            else:
                parts = parts[1:-1]      # written as a markdown table row: | a | b | ... |
        if len(parts) == 2 and parts[0].upper() == "HOURS":
            hours = parts[1] or None
            continue
        if (len(parts) == 5 and parts[4].lower() in CATEGORIES
                and parts[3].lower() not in CATEGORIES):
            # The model put a sub-heading in its own column:
            #   COFFEE | KID'S | LITTLE LATTE | 3.25 | drink
            # The sub-heading is the closer heading, so it becomes the section.
            parts = [parts[1], parts[2], parts[3], parts[4], ""]
        if len(parts) == 4:
            parts.append("")
        if len(parts) != 5:
            continue
        section, item, prices, category, options = parts
        if not item or item.lower() == "item" or set(item) <= set("-: "):   # header or table rule
            continue
        if pending_sizes:
            sizes_by_section[section] = pending_sizes
            pending_sizes = None
        item_lines.append(parts)
    if pending_sizes and item_lines:
        sizes_by_section.setdefault(item_lines[-1][0], pending_sizes)

    rows = []
    for line_number, (section, item, prices, category, options) in enumerate(item_lines):
        variants = [option.strip() for option in options.split(";") if option.strip()]
        pairs = parse_price_list(prices, sizes_by_section.get(section)) or [("", "")]
        for size, price in pairs:
            # "line" lets build_items() keep all the prices of one line on one item.
            rows.append({"section": section, "item": item, "size": size, "price": price,
                         "category": category, "variants": variants,
                         "line": line_number, "line_prices": len(pairs)})
    if not rows:
        return None
    return {"hours": hours, "items": rows}


# What we call sizes the menu doesn't name ("$4.50/$5.50"), smallest first.
# Only the label is ours; the prices are exactly the ones the model read.
UNNAMED_SIZES = {2: ["small", "large"], 3: ["small", "medium", "large"]}


def parse_price_list(text, size_names=None):
    """'SM 8.5; LG 9.25' -> [('SM', '8.5'), ('LG', '9.25')].   '4.5' -> [('', '4.5')].

    Prices without labels take size_names (a size row printed above them) when
    there is exactly one name per price. A piece without a number at its end is
    dropped: no price is ever made up.
    """
    pairs = []
    for piece in text.split(";"):
        match = re.fullmatch(r"\s*(.*?)\s*\$?(\d+(?:\.\d+)?)\s*", piece)
        if match:
            pairs.append((match.group(1).strip(" :-="), match.group(2)))
    if len(pairs) > 1 and not any(size for size, _ in pairs):
        if size_names and len(size_names) == len(pairs):
            names = size_names
        else:
            names = UNNAMED_SIZES.get(len(pairs))
        if names:
            pairs = list(zip(names, [price for _, price in pairs]))
    return pairs


def parse_usd(value):
    """'$4.50' -> 4.5, 4.5 -> 4.5, '' -> None. Never guesses: no clear number means None."""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        usd = float(value)
    else:
        usd = _usd_from_text(str(value).strip())
    # Models write 0 when they see no price. Zero means "no price", not "free".
    return usd if usd is not None and usd > 0 else None


def _usd_from_text(text):
    """The price formats seen on menus. Anything else is None."""
    text = text.lstrip("+").strip()                       # "+.50" is an add-on price of 0.50
    cents = re.fullmatch(r"(\d+(?:\.\d+)?)\s*(?:¢|c|cents?)", text, re.IGNORECASE)
    if cents:                                             # "50¢"
        return float(cents.group(1)) / 100
    clock = re.fullmatch(r"\$?\s*(\d+):(\d{2})", text)    # "$11:00", a colon written for the point
    if clock:
        return int(clock.group(1)) + int(clock.group(2)) / 100
    plain = re.fullmatch(r"\$?\s*(\d+(?:\.\d*)?|\.\d+)\s*\$?", text)   # "$4.50", "4.5", "10.5", ".50"
    return float(plain.group(1)) if plain else None


# A size written into the name: "French fries (Small)", "ACAI COPO 12 OZ".
_SIZE_WORDS = r"small|medium|large|extra\s*large|x-?large|regular|sm|md|med|lg|xl"
_SIZE_IN_BRACKETS = re.compile(rf"^(.*\S)\s*\(\s*({_SIZE_WORDS}|\d+(?:\.\d+)?\s*oz\.?)\s*\)$", re.IGNORECASE)
_OZ_AT_END = re.compile(r"^(.*\S)\s+(\d+(?:\.\d+)?\s*oz\.?)$", re.IGNORECASE)


def split_size_from_name(name):
    """'French fries (Small)' -> ('French fries', 'Small'). 'Latte' -> ('Latte', None).

    Only two clear patterns: a size word in brackets at the end, or ounces at the end.
    """
    for pattern in (_SIZE_IN_BRACKETS, _OZ_AT_END):
        match = pattern.match(name)
        if match:
            return match.group(1).strip(" -,"), match.group(2).strip()
    return name, None


def _text(value):
    return value.strip() if isinstance(value, str) else ""


def _list(value):
    return value if isinstance(value, list) else []


def build_items(parsed):
    """Model JSON -> list of MenuItem. Skips anything without an item name.

    Accepts both shapes a reader can ask for:
      nested: {"item": ..., "prices": [{"size": ..., "usd": ...}], ...}
      flat:   {"item": ..., "size": ..., "price": ...}   one row per price
    Flat rows for the same item in the same section are merged into one item
    when they have different sizes.
    """
    items = []
    by_key = {}   # (section, item) -> MenuItem, for merging flat rows
    item_of_line = {}   # reply line number -> the MenuItem made from that line
    for raw in _list(parsed.get("items")):
        if not isinstance(raw, dict) or not _text(raw.get("item")):
            continue

        is_flat = "prices" not in raw
        prices = []
        if is_flat:
            price_rows = [{"size": raw.get("size"), "usd": raw.get("price")}]
        else:
            price_rows = [price for price in _list(raw.get("prices")) if isinstance(price, dict)]

        # A size written into the name moves to the size, when the item has one
        # price and that price has no size of its own.
        name, size_in_name = split_size_from_name(_text(raw["item"]))
        if (size_in_name and len(price_rows) == 1 and not _text(price_rows[0].get("size"))
                and raw.get("line_prices", 1) == 1):
            raw = {**raw, "item": name}
            price_rows = [{**price_rows[0], "size": size_in_name}]
        for price in price_rows:
            if not isinstance(price, dict):
                continue
            usd = parse_usd(price.get("usd"))
            if usd is not None:   # no readable price -> no price entry; never invent one
                prices.append(Price(size=_text(price.get("size")) or None, usd=usd))

        if is_flat:
            key = (_text(raw.get("section")).lower(), _text(raw["item"]).lower())
            earlier = by_key.get(key)
            new_sizes = {price.size for price in prices}
            # Prices written on one line belong to one item, named sizes or not
            # ("Drip Coffee 2 / 2.75 / 3.50 / 4").
            line_item = item_of_line.get(raw.get("line")) if raw.get("line") is not None else None
            if line_item is not None and prices:
                line_item.prices.extend(prices)
                continue
            if (earlier is not None and prices and None not in new_sizes
                    and not new_sizes & {price.size for price in earlier.prices}):
                earlier.prices.extend(prices)
                continue

        add_ons = []
        for add_on in _list(raw.get("add_ons")):
            if isinstance(add_on, dict) and _text(add_on.get("name")):
                add_ons.append(AddOn(name=_text(add_on["name"]), usd=parse_usd(add_on.get("usd"))))

        category = _text(raw.get("category")).lower()
        item = MenuItem(
            section=_text(raw.get("section")) or None,
            item=_text(raw["item"]),
            category=category if category in CATEGORIES else FALLBACK_CATEGORY,
            prices=prices,
            add_ons=add_ons,
            variants=[_text(v) for v in _list(raw.get("variants")) if _text(v)],
            tags=[_text(t) for t in _list(raw.get("tags")) if _text(t)],
        )
        items.append(item)
        if is_flat:
            by_key.setdefault(key, item)
            if raw.get("line") is not None:
                item_of_line[raw["line"]] = item
    return items
