"""Owner insights: the counts are computed here in code; the model only
writes the sentences around them, and its text must pass the grounding check.
"""

import re
from collections import Counter
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

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


# ---------- the weekly job: cafes/{id}/insights/{weekStart} (docs/contracts.md section 1) ----------

def last_week_start(today=None, tz="America/New_York"):
    """The Monday that starts the most recent complete Monday-to-Sunday week, in the café's time zone."""
    today = today or datetime.now(ZoneInfo(tz)).date()
    return today - timedelta(days=today.weekday() + 7)


def week_bounds(week_start, tz="America/New_York"):
    """(start, end) of the week as UTC ISO strings: Monday 00:00 to the next Monday 00:00, local time."""
    zone = ZoneInfo(tz)
    start = datetime.combine(week_start, time.min, tzinfo=zone)
    end = datetime.combine(week_start + timedelta(days=7), time.min, tzinfo=zone)
    as_utc = lambda moment: moment.astimezone(timezone.utc).isoformat(timespec="seconds")      # noqa: E731
    return as_utc(start), as_utc(end)


def week_counts(store, cafe, week_start, tz="America/New_York"):
    """The week's numbers for one café, counted here in code from the iMessage events:
    (counts, topItems). Activity from the app is not included yet."""
    start, end = week_bounds(week_start, tz)
    events = [event for event in store.list_events(since=start) if event.created_at < end]
    shown = [event for event in events if event.kind == "search" and cafe.cafe_id in event.data.get("shown", [])]
    views = [event for event in events if event.kind == "menu_view" and event.cafe_id == cafe.cafe_id]
    picks = [event for event in events if event.kind == "pick" and event.cafe_id == cafe.cafe_id]
    updates = [event for event in events if event.kind == "menu_update" and event.cafe_id == cafe.cafe_id]
    customers = {event.phone_hash for event in shown + views + picks if event.phone_hash}

    # What people asked for, in their own words; an item is "mentioned" when a question names it.
    asked = ([(event.data.get("query") or "").lower() for event in shown]
             + [(event.data.get("contains") or "").lower() for event in views])
    version = store.get_current_menu(cafe.cafe_id)
    mentions = Counter()
    for item in (version.items if version else []):
        name = item.item.strip().lower()
        count = sum(1 for question in asked if name and name in question)
        if count:
            mentions[item.item] += count
    counts = {"customerQuestions": len(shown) + len(views), "uniqueCustomers": len(customers),
              "menuUpdates": len(updates), "timesSuggested": len(shown), "timesPicked": len(picks)}
    top_items = [{"name": name, "mentions": count} for name, count in mentions.most_common(5)]
    return counts, top_items


def week_summary(cafe_name, counts, top_items, model=None):
    """Two or three sentences for the owner. The numbers are the counts; the model only words them, and its
    text is thrown away for the plain version if it states anything that isn't in the facts."""
    if not counts["customerQuestions"] and not counts["menuUpdates"] and not counts["timesPicked"]:
        return f"No customer questions about {cafe_name} came through JOLO last week."
    plain = (f"Last week {counts['customerQuestions']} questions from {counts['uniqueCustomers']} people led to "
             f"{cafe_name}; it was suggested {counts['timesSuggested']} times and picked {counts['timesPicked']} times. "
             f"Your menu was updated {counts['menuUpdates']} times.")
    if top_items:
        plain += " Most asked about: " + ", ".join(f"{item['name']} ({item['mentions']})" for item in top_items) + "."
    if model is None:
        return plain
    facts = f"Café: {cafe_name}\nCounts: {counts}\nMost asked-about items: {top_items}"
    try:
        text = model.invoke([SystemMessage(PROMPT), HumanMessage(facts)]).content.strip()
    except Exception:
        return plain
    known = set(re.findall(r"\d+", facts))
    if not text or ungrounded_facts(text, [facts]) or not all(number in known for number in re.findall(r"\d+", text)):
        return plain
    return text


def week_report(store, cafe, week_start, model=None, tz="America/New_York", now=None):
    """The insights document for one café and week, as the contract defines it."""
    counts, top_items = week_counts(store, cafe, week_start, tz)
    return {
        "weekStart": week_start.isoformat(),
        "counts": counts,
        "topItems": top_items,
        "summary": week_summary(cafe.name, counts, top_items, model),
        "generatedAt": (now or datetime.now(timezone.utc)).isoformat(timespec="seconds"),
        "source": "imessage",          # counts cover questions asked over iMessage, not activity in the app
    }


def write_weekly_insights(store, week_start, model=None, tz="America/New_York", only=None, dry_run=False, now=None):
    """One document per café that has an owner (only they can read it). Returns {cafe_id: document}.
    Running it again for the same week replaces that week's documents."""
    written = {}
    for cafe in store.list_cafes():
        if not cafe.owner_phone_hash or (only and cafe.cafe_id != only):
            continue
        report = week_report(store, cafe, week_start, model, tz, now)
        if not dry_run:
            store.save_insight(cafe.cafe_id, report)
        written[cafe.cafe_id] = report
    return written
