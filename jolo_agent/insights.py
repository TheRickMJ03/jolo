"""Owner insights: the counts are computed here in code; the model only
writes the sentences around them, and its text must pass the grounding check.
"""

import re
from collections import Counter
from datetime import datetime, timedelta, timezone

from langchain_core.messages import HumanMessage, SystemMessage

from jolo_agent.grounding import ungrounded_facts

PROMPT = ("You write a short weekly update for a café owner, as a text message. Use ONLY the numbers "
          "given. Two or three plain sentences, no markdown, no advice that needs facts you don't have.")


def weekly_counts(store, cafe_id, now=None, days=7):
    """What happened for one café in the last `days` days."""
    now = now or datetime.now(timezone.utc)
    since = (now - timedelta(days=days)).isoformat(timespec="seconds")
    searches = [event for event in store.list_events("search", since) if cafe_id in event.data.get("shown", [])]
    picks = [event for event in store.list_events("pick", since) if event.cafe_id == cafe_id]
    views = [event for event in store.list_events("menu_view", since) if event.cafe_id == cafe_id]
    updates = [event for event in store.list_events("menu_update", since) if event.cafe_id == cafe_id]
    queries = Counter((event.data.get("query") or "").strip().lower() for event in searches)
    queries.pop("", None)
    looked_for = Counter((event.data.get("contains") or "").strip().lower() for event in views)
    looked_for.pop("", None)
    return {
        "days": days,
        "times_suggested": len(searches),
        "times_picked": len(picks),
        "menu_views": len(views),
        "menu_updates": len(updates),
        "top_searches": [query for query, _count in queries.most_common(3)],
        "top_items_looked_for": [item for item, _count in looked_for.most_common(3)],
    }


def plain_summary(cafe_name, counts):
    """The summary without the model: always correct, a little dry."""
    if not (counts["times_suggested"] or counts["menu_views"] or counts["times_picked"] or counts["menu_updates"]):
        return f"No activity for {cafe_name} in the last {counts['days']} days yet."
    text = (f"Last {counts['days']} days for {cafe_name}: suggested {counts['times_suggested']} times, "
            f"picked {counts['times_picked']} times, menu viewed {counts['menu_views']} times, "
            f"menu updated {counts['menu_updates']} times.")
    if counts["top_searches"]:
        text += " Top searches that led to you: " + ", ".join(counts["top_searches"]) + "."
    if counts["top_items_looked_for"]:
        text += " Items people looked for: " + ", ".join(counts["top_items_looked_for"]) + "."
    return text


def owner_summary(store, cafe, model=None, now=None):
    """The weekly update as text. Falls back to plain_summary when there is no
    model, the model is down, or its text states a number that isn't in the counts."""
    counts = weekly_counts(store, cafe.cafe_id, now)
    plain = plain_summary(cafe.name, counts)
    if model is None or plain.startswith("No activity"):
        return plain
    facts = f"Café: {cafe.name}\nCounts: {counts}"
    try:
        text = model.invoke([SystemMessage(PROMPT), HumanMessage(facts)]).content.strip()
    except Exception:
        return plain
    # Stricter than the usual check: here every number must be one of the counts.
    known = set(re.findall(r"\d+", facts))
    numbers_ok = all(number in known for number in re.findall(r"\d+", text))
    if not text or ungrounded_facts(text, [facts]) or not numbers_ok:
        return plain
    return text
