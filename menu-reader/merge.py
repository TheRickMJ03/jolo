"""Merge the results of several photos of one menu into one MenuResult.

A menu is often photographed in parts (curiosity_07a, 07b, 07c). The agent
calls extract_menu() once per photo, then merge_results() on the list.
"""

from menu_reader.compare import _key, _size_key, compare_menus
from menu_reader.schema import MenuResult


def _item_key(item):
    """Two items are the same entry when section, name and prices all agree."""
    prices = tuple(sorted((_size_key(price.size), round(price.usd, 2)) for price in item.prices))
    return _key(item.section), _key(item.item), prices


def merge_results(results, current_menu=None):
    """results: MenuResults (or their dicts) of photos of the same menu, in order.

    - Unreadable photos are skipped. If none is readable, the first one's
      reason is returned.
    - An item that appears on two photos with the same section, name and
      prices is kept once (the copy with the higher confidence). The same name
      with different prices is kept twice: the pipeline doesn't pick a winner.
    - "changes" is worked out again on the merged menu when current_menu is
      given. Per-photo changes are not combined: a photo of half the menu
      reports the other half as missing.
    """
    results = [r if isinstance(r, MenuResult) else MenuResult.model_validate(r) for r in results]
    timings = {}
    for result in results:
        for stage, seconds in result.timings.items():
            timings[stage] = timings.get(stage, 0.0) + seconds

    readable = [result for result in results if result.readable]
    if not readable:
        reason = results[0].reason if results else "no_photos"
        return MenuResult(readable=False, reason=reason, timings=timings)

    merged = {}   # key -> item, in first-seen order
    for result in readable:
        for item in result.items:
            key = _item_key(item)
            if key not in merged or item.confidence > merged[key].confidence:
                merged[key] = item
    items = list(merged.values())

    out = MenuResult(
        readable=True,
        confidence=round(sum(item.confidence for item in items) / len(items), 2) if items else 0.0,
        hours=next((result.hours for result in readable if result.hours), None),
        items=items,
        timings=timings,
    )
    if current_menu is not None:
        out.changes = compare_menus(current_menu, items)
    return out
