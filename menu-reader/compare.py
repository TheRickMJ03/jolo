"""Compare the menu read from a photo with the café's current menu.

It only reports what it sees: new items, price changes, and items that are in
the current menu but not in the photo. It never decides that a missing item was
removed; the photo may show only part of the menu. The agent asks the owner.
"""

import re
import unicodedata

from rapidfuzz import fuzz

from menu_reader.schema import Changes, MenuItem, MenuResult, PriceChange

# Two names this similar (0-100) are the same item: "Capuccino" and "Cappuccino".
NAME_MATCH_THRESHOLD = 90


def _key(text):
    """Lowercase, no accents, no punctuation: 'Açaí Bowl' -> 'acai bowl'."""
    text = unicodedata.normalize("NFKD", text or "")
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    return re.sub(r"[^a-z0-9]+", " ", text.lower().replace("'", "").replace("’", "")).strip()


def _size_key(size):
    return _key(size).replace(" ", "")


def to_items(menu):
    """Accept the current menu in any of the shapes a teammate might hold:
    a MenuResult, a dict with "items", or a plain list of items (dicts or MenuItem)."""
    if menu is None:
        return []
    if isinstance(menu, MenuResult):
        return list(menu.items)
    if isinstance(menu, dict):
        menu = menu.get("items") or []
    return [item if isinstance(item, MenuItem) else MenuItem.model_validate(item) for item in menu]


def _pair_items(old_items, new_items, threshold):
    """Pair each old item with at most one new item. Returns {old index: new index}.

    Best pairs first: the same name in the same section beats the same name in
    another section ("Açai" the smoothie and "Açai" the bowl), which beats a
    near-identical spelling.
    """
    candidates = []
    for i, old in enumerate(old_items):
        for j, new in enumerate(new_items):
            score = fuzz.ratio(_key(old.item), _key(new.item))
            if score >= threshold:
                same_section = _key(old.section) == _key(new.section)
                candidates.append((score, same_section, -abs(i - j), i, j))
    pairs, used_new = {}, set()
    for _score, _same, _near, i, j in sorted(candidates, reverse=True):
        if i not in pairs and j not in used_new:
            pairs[i] = j
            used_new.add(j)
    return pairs


def _price_changes(old, new):
    """Price changes between two versions of one item."""
    if not new.prices:
        return []      # the photo shows no price for it: nothing to compare, nothing changed
    old_by_size = {_size_key(price.size): price for price in old.prices}
    new_by_size = {_size_key(price.size): price for price in new.prices}

    # One price on each side is the same price, even if only one side names the size.
    if len(old.prices) == 1 and len(new.prices) == 1:
        old_price, new_price = old.prices[0], new.prices[0]
        if abs(old_price.usd - new_price.usd) < 0.005:
            return []
        return [PriceChange(item=new.item, size=new_price.size or old_price.size,
                            old_usd=old_price.usd, new_usd=new_price.usd)]

    changes = []
    for size, new_price in new_by_size.items():
        old_price = old_by_size.get(size)
        if old_price is None:
            changes.append(PriceChange(item=new.item, size=new_price.size, old_usd=None, new_usd=new_price.usd))
        elif abs(old_price.usd - new_price.usd) >= 0.005:
            changes.append(PriceChange(item=new.item, size=new_price.size,
                                       old_usd=old_price.usd, new_usd=new_price.usd))
    for size, old_price in old_by_size.items():
        if size not in new_by_size:
            changes.append(PriceChange(item=new.item, size=old_price.size, old_usd=old_price.usd, new_usd=None))
    return changes


def compare_menus(current_menu, new_items, threshold=NAME_MATCH_THRESHOLD):
    """current_menu: what the café has now. new_items: what the photo shows.

    Returns Changes:
      new_items           names in the photo that the current menu doesn't have
      price_changes       per size; old_usd or new_usd is None when a size appeared or disappeared
      missing_from_photo  names in the current menu that the photo doesn't show
    """
    old_items = to_items(current_menu)
    new_items = to_items(new_items)
    pairs = _pair_items(old_items, new_items, threshold)
    paired_new = set(pairs.values())

    price_changes = []
    for i, j in sorted(pairs.items(), key=lambda pair: pair[1]):
        price_changes.extend(_price_changes(old_items[i], new_items[j]))

    return Changes(
        new_items=[item.item for j, item in enumerate(new_items) if j not in paired_new],
        price_changes=price_changes,
        missing_from_photo=[item.item for i, item in enumerate(old_items) if i not in pairs],
    )
