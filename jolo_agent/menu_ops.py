"""Pure functions on menu items: find one by the owner's wording, apply the
owner's fixes, and turn a read plus a scope into the menu that gets saved.

No store, no model, no messages: everything here is plain data in, data out.
"""

from rapidfuzz import fuzz

# The reader's own name matching, so "the same item" means the same thing here
# as in the changes it reports. (_pair_items and _key are private there; ask
# Ricardo before he renames them.)
from menu_reader.compare import NAME_MATCH_THRESHOLD, _key, _pair_items, _size_key, compare_menus
from menu_reader.schema import MenuItem, Price

GENERIC_SIZES = {"small", "medium", "large", "sm", "md", "lg", "s", "m", "l", "regular", "extralarge", "xl"}


class EditError(ValueError):
    """The owner's fix can't be applied; the message is written for the owner."""


def format_usd(usd):
    return f"${usd:.2f}"


def format_prices(item):
    """'8 oz $4.50, 12 oz $5.00', '$3.00', or 'no price'."""
    if not item.prices:
        return "no price"
    return ", ".join(f"{price.size} {format_usd(price.usd)}" if price.size else format_usd(price.usd)
                     for price in item.prices)


def find_item(items, name, threshold=80):
    """Which item does the owner mean? Returns (index or None, names of close candidates).

    An exact name wins. Otherwise the closest spelling wins when it is clearly
    ahead; "latte" with Latte, Iced Latte and Caramel Latte on the menu and no
    exact match is ambiguous, and the candidates are returned for a question.
    """
    wanted = _key(name)
    if not wanted:
        return None, []
    exact = [index for index, item in enumerate(items) if _key(item.item) == wanted]
    if exact:
        return exact[0], []

    scored = sorted(((fuzz.ratio(wanted, _key(item.item)), index) for index, item in enumerate(items)),
                    reverse=True)
    if scored and scored[0][0] >= threshold and (len(scored) == 1 or scored[0][0] - scored[1][0] >= 5):
        return scored[0][1], []

    # The owner used part of the name: "cortado" for "Cortado aka Garoto or Pingado".
    partial = [index for index, item in enumerate(items)
               if fuzz.token_set_ratio(wanted, _key(item.item)) >= 90]
    if len(partial) == 1:
        return partial[0], []
    return None, [items[index].item for index in partial[:6]]


def _target(items, current_items, name, threshold):
    """The item to edit. Looks in the draft first, then in the stored menu
    (an item the photo didn't show is copied into the draft so it can be changed)."""
    index, candidates = find_item(items, name, threshold)
    if index is not None:
        return items[index]
    if not candidates:
        stored, stored_candidates = find_item(current_items, name, threshold)
        if stored is not None:
            items.append(current_items[stored].model_copy(deep=True))
            return items[-1]
        candidates = stored_candidates
    if candidates:
        raise EditError(f'Which one do you mean by "{name}": {", ".join(candidates)}?')
    raise EditError(f'I can\'t find "{name}" on the menu.')


def apply_op(items, current_items, op, threshold=80):
    """Apply one owner fix to items (in place). Returns (text for the owner, before, after).

    before/after are the item as a dict (or None), for the corrections log.
    Raises EditError when the fix can't be applied.

    Ops: set_price {item, usd, size?} · rename_item {item, new_name} ·
    rename_size {old_size, new_size, item?} · add_item {item, usd?, size?, category?, section?} ·
    remove_item {item} · keep_item {item}
    """
    kind = op["op"]

    if kind == "set_price":
        if op["usd"] is None or op["usd"] < 0:
            raise EditError("I need a price in dollars.")
        item = _target(items, current_items, op["item"], threshold)
        before = item.model_dump()
        size = op.get("size")
        if size:
            match = next((price for price in item.prices if _size_key(price.size) == _size_key(size)), None)
            if match:
                match.usd = float(op["usd"])
            else:
                item.prices.append(Price(size=size, usd=float(op["usd"])))
        elif len(item.prices) <= 1:
            item.prices = [Price(size=item.prices[0].size if item.prices else None, usd=float(op["usd"]))]
        else:
            sizes = ", ".join(price.size or "no size" for price in item.prices)
            raise EditError(f"{item.item} has several sizes ({sizes}). Which size is {format_usd(op['usd'])}?")
        item.confidence = 1.0        # the owner said so
        return f"{item.item} is now {format_prices(item)}.", before, item.model_dump()

    if kind == "rename_item":
        if not (op.get("new_name") or "").strip():
            raise EditError("What should the new name be?")
        item = _target(items, current_items, op["item"], threshold)
        before = item.model_dump()
        old_name, item.item = item.item, op["new_name"].strip()
        return f'Renamed "{old_name}" to "{item.item}".', before, item.model_dump()

    if kind == "rename_size":
        if not (op.get("new_size") or "").strip():
            raise EditError("What should the size be called?")
        scope = [_target(items, current_items, op["item"], threshold)] if op.get("item") else items
        changed = 0
        for item in scope:
            for price in item.prices:
                if _size_key(price.size) == _size_key(op["old_size"]):
                    price.size = op["new_size"].strip()
                    changed += 1
        if not changed:
            raise EditError(f'I don\'t see the size "{op["old_size"]}" on the items I read.')
        where = f" on {scope[0].item}" if op.get("item") else f" on {changed} price{'s' if changed != 1 else ''}"
        return f'Size "{op["old_size"]}" is now "{op["new_size"].strip()}"{where}.', None, None

    if kind == "add_item":
        name = (op.get("item") or "").strip()
        if not name:
            raise EditError("What is the item called?")
        index, _candidates = find_item(items, name, 95)
        if index is not None:
            raise EditError(f"{items[index].item} is already there ({format_prices(items[index])}). "
                            "Tell me its new price if it changed.")
        prices = [Price(size=op.get("size") or None, usd=float(op["usd"]))] if op.get("usd") is not None else []
        category = op.get("category") if op.get("category") in ("drink", "food", "modifier") else "drink"
        item = MenuItem(section=op.get("section") or None, item=name, category=category,
                        prices=prices, confidence=1.0)
        items.append(item)
        return f"Added {item.item} ({format_prices(item)}).", None, item.model_dump()

    if kind == "remove_item":
        # Removal is applied in final_items(): the item may be in the photo, in the stored menu, or both.
        index, candidates = find_item(items, op["item"], threshold)
        stored, stored_candidates = find_item(current_items, op["item"], threshold)
        if index is None and stored is None:
            options = candidates or stored_candidates
            if options:
                raise EditError(f'Which one do you mean by "{op["item"]}": {", ".join(options)}?')
            raise EditError(f'I can\'t find "{op["item"]}" on the menu.')
        item = items[index] if index is not None else current_items[stored]
        op["item"] = item.item
        return f"I'll leave {item.item} off the menu.", item.model_dump(), None

    if kind == "keep_item":
        stored, candidates = find_item(current_items, op["item"], threshold)
        if stored is None:
            if candidates:
                raise EditError(f'Which one do you mean by "{op["item"]}": {", ".join(candidates)}?')
            raise EditError(f'I can\'t find "{op["item"]}" on your current menu.')
        op["item"] = current_items[stored].item
        return f"I'll keep {current_items[stored].item} on the menu.", None, None

    raise EditError(f"Unknown fix {kind!r}.")


def replay_ops(items, current_items, ops, threshold=80):
    """Re-apply the owner's earlier fixes after the photos were merged again.
    A fix that no longer applies (its item is gone) is skipped."""
    for op in ops:
        try:
            apply_op(items, current_items, dict(op), threshold)
        except EditError:
            pass
    return items


def final_items(current_items, photo_items, scope, ops=()):
    """The menu that would be saved.

    partial: the stored menu, with the photo's items updated in place and its new items added.
        Items the photo doesn't show stay untouched.
    full: the photo's items. Stored items the photo doesn't show are dropped,
        except the ones the owner asked to keep.
    Either way, items the owner asked to remove are dropped.
    An item the photo shows without a price keeps its stored price.
    """
    removed = {_key(op["item"]) for op in ops if op["op"] == "remove_item"}
    kept = {_key(op["item"]) for op in ops if op["op"] == "keep_item"}
    pairs = _pair_items(current_items, photo_items, NAME_MATCH_THRESHOLD)     # stored index -> photo index
    stored_of = {photo_index: stored_index for stored_index, photo_index in pairs.items()}

    def updated(photo_index):
        item = photo_items[photo_index].model_copy(deep=True)
        if photo_index in stored_of:
            old = current_items[stored_of[photo_index]]
            if not item.prices:
                item.prices = [price.model_copy() for price in old.prices]
            if item.section is None:
                item.section = old.section
        return item

    if scope == "full":
        result = [updated(index) for index in range(len(photo_items))]
        result += [item.model_copy(deep=True) for index, item in enumerate(current_items)
                   if index not in pairs and _key(item.item) in kept]
    else:
        result = [updated(pairs[index]) if index in pairs else item.model_copy(deep=True)
                  for index, item in enumerate(current_items)]
        result += [updated(index) for index in range(len(photo_items)) if index not in stored_of]
    return [item for item in result if _key(item.item) not in removed]


def changes_between(current_items, new_items):
    """The reader's comparison, between the stored menu and the menu that would be saved."""
    return compare_menus(current_items, new_items)


def items_to_check(new_items, changes, first_menu):
    """The items the owner should look at, least confident first.

    Only what this update adds or reprices; on a café's first menu, everything.
    """
    if first_menu:
        touched = list(new_items)
    else:
        names = {_key(name) for name in changes.new_items} | {_key(change.item) for change in changes.price_changes}
        touched = [item for item in new_items if _key(item.item) in names]
    return sorted(touched, key=lambda item: item.confidence)     # stable: menu order within a tie


def has_generic_sizes(items):
    """True when sizes came back as Small/Large: often a lost "12oz / 16oz" column heading."""
    return any(_size_key(price.size) in GENERIC_SIZES for item in items for price in item.prices if price.size)
