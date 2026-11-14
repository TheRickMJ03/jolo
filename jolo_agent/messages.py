"""Every fixed text JOLO sends. Isaiah owns the wording: edit it here, nowhere else.

These are written by code, not by the model, so every number in them comes
straight from the store or the reader.
"""

from jolo_agent.menu_ops import format_prices, format_usd

READING = "Reading your menu…"
ASK_SCOPE = "Is this your full menu, or just part of it?"
STILL_READING = "I'm still reading your photo. One moment."
PHOTO_UNREADABLE = "I couldn't read that photo. Can you send a clearer one?"
READER_DOWN = "I can't read menus right now. Try again in a minute."
MODEL_DOWN = "I can't answer right now. Try again in a minute."
NOT_AN_OWNER = ("This number isn't linked to a café yet, so I can't update a menu from it. "
                "Sign in to the JOLO app as an owner first.")
PHOTO_FROM_CUSTOMER = "Thanks! For now I can only read menu photos sent by a café's owner."
NOTHING_TO_CONFIRM = "There's no menu update waiting. Send me a photo of your menu to start one."
NO_CHANGES = "I read it, and nothing differs from the menu I have. No update needed."
CANCELLED = "OK, I dropped that update. Your menu is unchanged."
EMPTY_MENU = "That would leave your menu empty, so I didn't save it. Send a photo or tell me what to keep."
NO_MORE = "That's everything I wanted you to check."
REPLY_YES = 'Reply "yes" to save, or tell me what to fix.'
EMPTY_MESSAGE = "Send me a message or a menu photo."
SIZES_NOTE = ('Some sizes came back as Small/Medium/Large. If your menu prints ounces instead '
              '(like 12oz / 16oz), tell me and I\'ll fix them.')


def scope_set(scope, still_reading):
    text = "Got it, the full menu." if scope == "full" else "Got it, just part of the menu."
    return text + (" Still reading…" if still_reading else "")


def read_done_need_scope(count):
    return f"I've read it and found {count} item{'s' if count != 1 else ''}. {ASK_SCOPE}"


def photos_failed(failed, reader_down):
    """Some photos of a set could not be used; the others were."""
    photos = "1 photo" if failed == 1 else f"{failed} photos"
    if reader_down:
        return f"I couldn't read {photos} because the reader was down. Send {'it' if failed == 1 else 'them'} again in a minute."
    return f"I couldn't read {photos}. Send {'a clearer one' if failed == 1 else 'clearer ones'} if {'it shows' if failed == 1 else 'they show'} more of the menu."


def _listed(names, limit=8):
    names = list(names)
    more = len(names) - limit
    return ", ".join(names[:limit]) + (f", and {more} more" if more > 0 else "")


def check_lines(items, start):
    return [f"{start + index + 1}. {item.item}: {format_prices(item)}" for index, item in enumerate(items)]


def change_counts(changes):
    """'2 new items, 3 price changes, 1 removed' (parts with a zero count are left out)."""
    parts = []
    for count, one, many in ((len(changes.new_items), "new item", "new items"),
                             (len(changes.price_changes), "price change", "price changes"),
                             (len(changes.missing_from_photo), "removed", "removed")):
        if count:
            parts.append(f"{count} {one if count == 1 else many}")
    return ", ".join(parts)


def price_change_text(change):
    size = f" ({change.size})" if change.size else ""
    if change.old_usd is None:
        return f"{change.item}{size} new at {format_usd(change.new_usd)}"
    if change.new_usd is None:
        return f"{change.item}{size} {format_usd(change.old_usd)} no longer listed"
    return f"{change.item}{size} {format_usd(change.old_usd)} -> {format_usd(change.new_usd)}"


def summary(found, changes, first_menu, to_check, check_start, more_left, sizes_note, full_scope):
    """The confirmation text: what would change, then the least certain items to check."""
    lines = []
    if first_menu:
        lines.append(f"Found {found} item{'s' if found != 1 else ''}. This will be your first menu on JOLO.")
    else:
        lines.append(f"Found {found} item{'s' if found != 1 else ''}: {change_counts(changes)}.")
        if changes.new_items:
            lines.append("New: " + _listed(changes.new_items))
        if changes.price_changes:
            lines.append("Price changes: " + _listed((price_change_text(c) for c in changes.price_changes), 6))
        if changes.missing_from_photo and full_scope:
            lines.append("Not in the photo, so I'll take them off the menu: "
                         + _listed(changes.missing_from_photo) + ". Tell me which to keep.")
    if to_check:
        lines.append("Please check these first, I'm least sure about them:")
        lines.extend(check_lines(to_check, check_start))
    if sizes_note:
        lines.append(SIZES_NOTE)
    lines.append('Reply "yes" to save, tell me what to fix, or say "more" to see the next items.' if more_left else REPLY_YES)
    return "\n".join(lines)


def more_items(to_check, check_start, more_left):
    lines = check_lines(to_check, check_start)
    lines.append('Reply "yes" to save, tell me what to fix, or say "more".' if more_left else REPLY_YES)
    return "\n".join(lines)


def pending(changes):
    counts = change_counts(changes)
    return (f"So far: {counts}. " if counts else "") + REPLY_YES


def saved(version, changes, first_menu, item_count):
    if first_menu:
        return f"Your menu is saved: {item_count} items."
    counts = change_counts(changes)
    return f"Your menu is updated (version {version})" + (f": {counts}." if counts else ".")


def menu_text(cafe_name, items, limit=40):
    """The owner's own menu as text."""
    if not items:
        return f"{cafe_name} has no menu on JOLO yet. Send me a photo of it."
    lines = [f"{cafe_name}, {len(items)} items:"]
    lines += [f"- {item.item}: {format_prices(item)}" for item in items[:limit]]
    if len(items) > limit:
        lines.append(f"…and {len(items) - limit} more. Ask me about a specific item.")
    return "\n".join(lines)
