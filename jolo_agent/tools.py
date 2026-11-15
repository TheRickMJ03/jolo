"""The tools the agent calls. Plain Python functions, wrapped for LangChain.

Three of the planned tools are deliberately NOT offered to the model; code
calls them instead, because a wrong call would be costly:
    find_cafe_by_phone   the phone number comes from the message, not from the model
    extract_menu         started by MenuUpdateFlow.start_read when a photo arrives
    save_menu_version    called only by MenuUpdateFlow.confirm, after the owner says yes

The model gets small sets, chosen by who is texting:
    customer   search_cafes, get_menu, get_hours, distance, record_pick
    owner      get_my_menu, get_insights and the fixes; with an update open,
               also set_scope, rename_size, keep_item, show_more, confirm_update, cancel_update
"""

import logging
from dataclasses import dataclass
from typing import Any, Literal

from langchain_core.tools import StructuredTool
from rapidfuzz import fuzz, process

from menu_reader.compare import _key
from jolo_agent import messages
from jolo_agent.menu_ops import format_prices
from jolo_agent.places import describe_day, is_open, local_now, miles_between, resolve_location
from jolo_agent.store.models import DAYS, hash_handle

EDIT_TOOLS = {"set_price", "rename_item", "rename_size", "add_item", "remove_item", "keep_item"}
MENU_LIMIT = 40
log = logging.getLogger("jolo.tools")


@dataclass
class Context:
    """Who is texting and what the tools may touch."""
    store: Any
    flow: Any
    search: Any
    config: dict
    phone_hash: str
    cafe: Any = None        # the owner's café, or None for a customer
    model: Any = None       # for the insights summary
    phone: str | None = None  # the raw handle, so the app can match this person
    focus: Any = None       # {"cafe_id", "name"}: the café this customer looked at most closely this turn
    focus_strong: bool = False  # True once they asked about one café by name (menu, hours, distance, pick)


def note_focus(ctx, cafe_id, name, strong=True):
    """The café to ask a review about later. A café they asked about wins over the top search result."""
    if not cafe_id or not name:
        return
    if strong or (not ctx.focus_strong and ctx.focus is None):
        ctx.focus = {"cafe_id": cafe_id, "name": name}
        ctx.focus_strong = ctx.focus_strong or strong


def remember_cafes(ctx, text, cafe_ids):
    """History on For you. Owners are skipped. A failed write never blocks the reply."""
    if ctx.cafe is not None or not ctx.phone:
        return
    try:
        ctx.store.record_customer_ask(ctx.phone, text, cafe_ids, history_only=True)
    except Exception:
        log.exception("Could not save the iMessage café for the app")


def find_cafe_by_phone(store, phone):
    """The café this phone number owns, with its current menu, or None ("not an owner")."""
    cafe = store.find_cafe_by_owner(hash_handle(phone))
    if cafe is None:
        return None
    version = store.get_current_menu(cafe.cafe_id)
    return {"cafe_id": cafe.cafe_id, "name": cafe.name, "version": cafe.current_version,
            "menu": version.model_dump() if version else None}


def resolve_cafe(store, reference):
    """The café for an id ("barbaras") or a name ("Barbara's"), or None."""
    cafe = store.get_cafe(reference)
    if cafe:
        return cafe
    cafes = store.list_cafes()
    names = {_key(cafe.name): cafe for cafe in cafes} | {_key(cafe.cafe_id): cafe for cafe in cafes}
    best = process.extractOne(_key(reference), list(names), scorer=fuzz.WRatio) if names else None
    return names[best[0]] if best and best[1] >= 85 else None


def _matching(items, contains):
    if not contains:
        return items
    wanted = _key(contains)
    return [item for item in items
            if wanted in _key(item.item) or fuzz.token_set_ratio(wanted, _key(item.item)) >= 85]


def _tool(function, description):
    return StructuredTool.from_function(func=function, name=function.__name__, description=description)


def _listed(item, sold_out):
    entry = {"item": item.item, "category": item.category, "prices": format_prices(item)}
    if item.item in sold_out:
        entry["sold_out"] = True
    return entry


# ---------- customer ----------

def customer_tools(ctx):
    store = ctx.store
    timezone = ctx.config["agent"]["timezone"]

    def unknown(cafe_id):
        return {"error": f'No café matches "{cafe_id}". Use a cafe_id from search_cafes.'}

    def search_cafes(query: str, near: str | None = None, open_now: bool = False, max_miles: float | None = None):
        found = ctx.search.search(query, near=near, open_now=open_now, max_miles=max_miles,
                                  phone_hash=ctx.phone_hash, phone=ctx.phone)
        top = (found.get("results") or [None])[0] if isinstance(found, dict) else None
        if top:
            note_focus(ctx, top.get("cafe_id"), top.get("name"), strong=False)
        return found

    def get_menu(cafe_id: str, contains: str | None = None):
        cafe = resolve_cafe(store, cafe_id)
        if cafe is None:
            return unknown(cafe_id)
        version = store.get_current_menu(cafe.cafe_id)
        if version is None:
            return {"cafe_id": cafe.cafe_id, "name": cafe.name, "items": [], "note": "This café has no menu on JOLO yet."}
        items = _matching(version.items, contains)
        store.add_event("menu_view", cafe.cafe_id, ctx.phone_hash, {"contains": contains})
        remember_cafes(ctx, contains or cafe.name, [cafe.cafe_id])
        note_focus(ctx, cafe.cafe_id, cafe.name)
        out = {"cafe_id": cafe.cafe_id, "name": cafe.name, "menu_updated": version.created_at[:10],
               "items": [_listed(item, version.sold_out) for item in items[:MENU_LIMIT]]}
        if version.sold_out:
            out["note"] = "Items marked sold_out are not available right now."
        if len(items) > MENU_LIMIT:
            out["note"] = f"{len(items) - MENU_LIMIT} more items not shown. Use contains to look for one."
        if contains and not items:
            out["note"] = f'Nothing on this menu matches "{contains}".'
        return out

    def get_hours(cafe_id: str):
        cafe = resolve_cafe(store, cafe_id)
        if cafe is None:
            return unknown(cafe_id)
        if not cafe.hours:
            return {"cafe_id": cafe.cafe_id, "name": cafe.name, "note": "No opening hours are stored for this café.",
                    "printed_on_menu": cafe.hours_text}
        now = local_now(timezone)
        remember_cafes(ctx, cafe.name, [cafe.cafe_id])
        note_focus(ctx, cafe.cafe_id, cafe.name)
        return {"cafe_id": cafe.cafe_id, "name": cafe.name, "today": DAYS[now.weekday()],
                "open_now": is_open(cafe.hours, now),
                "hours": {day: describe_day(cafe.hours.get(day)) for day in DAYS}}

    def distance(origin: str, cafe_id: str):
        cafe = resolve_cafe(store, cafe_id)
        if cafe is None:
            return unknown(cafe_id)
        start = resolve_location(origin, store.list_cafes())
        if start is None:
            return {"error": f'I don\'t know where "{origin}" is. Ask the customer for a landmark or a street corner.'}
        if cafe.lat is None or cafe.lng is None:
            return {"error": f"No location is stored for {cafe.name}."}
        remember_cafes(ctx, cafe.name, [cafe.cafe_id])
        note_focus(ctx, cafe.cafe_id, cafe.name)
        return {"from": origin, "cafe": cafe.name, "address": cafe.address,
                "miles": round(miles_between(start, (cafe.lat, cafe.lng)), 1)}

    def record_pick(cafe_id: str):
        cafe = resolve_cafe(store, cafe_id)
        if cafe is None:
            return unknown(cafe_id)
        searches = [event for event in store.list_events("search") if event.phone_hash == ctx.phone_hash]
        last = searches[-1].data if searches else {}
        store.add_event("pick", cafe.cafe_id, ctx.phone_hash,
                        {"query": last.get("query"), "shown": last.get("shown", [])})
        remember_cafes(ctx, cafe.name, [cafe.cafe_id])
        note_focus(ctx, cafe.cafe_id, cafe.name)
        return {"recorded": cafe.name}

    return [
        _tool(search_cafes, "Find cafés for a request. query: what the customer wants, in their words "
                            "(a drink, a dish, a vibe). near: where they are (a landmark or street), if they said. "
                            "open_now: true to keep only cafés open right now. Returns up to 5 cafés with matching "
                            "menu items and prices."),
        _tool(get_menu, "The current menu of one café, with prices. cafe_id: the café's name as the customer said "
                        'it, or the cafe_id from search_cafes. contains: only items matching this word, '
                        'for example "latte".'),
        _tool(get_hours, "Opening hours of one café for each day, and whether it is open right now. cafe_id: "
                         "the café's name as the customer said it, or the cafe_id from search_cafes."),
        _tool(distance, "Miles from a place to one café. Call it for EVERY question about how far a café is from "
                        "somewhere, even when the place sounds odd or unknown: the tool says whether it knows the "
                        "place. origin: the place as the customer said it. cafe_id: the café's name as the customer "
                        "said it, or the cafe_id from search_cafes. Never write an id yourself."),
        _tool(record_pick, "Call this when the customer says which café they chose or that they are going there."),
    ]


# ---------- owner ----------

def owner_tools(ctx, draft):
    flow, phone_hash = ctx.flow, ctx.phone_hash

    def get_my_menu(contains: str | None = None):
        version = ctx.store.get_current_menu(ctx.cafe.cafe_id)
        return messages.menu_text(ctx.cafe.name, _matching(version.items if version else [], contains))

    def get_insights():
        from jolo_agent.insights import owner_summary
        return owner_summary(ctx.store, ctx.cafe, ctx.model)

    def set_price(item: str, usd: float, size: str | None = None):
        return flow.edit(phone_hash, {"op": "set_price", "item": item, "usd": usd, "size": size})

    def rename_item(item: str, new_name: str):
        return flow.edit(phone_hash, {"op": "rename_item", "item": item, "new_name": new_name})

    def rename_size(old_size: str, new_size: str, item: str | None = None):
        return flow.edit(phone_hash, {"op": "rename_size", "old_size": old_size, "new_size": new_size, "item": item})

    def add_item(item: str, usd: float | None = None, size: str | None = None,
                 category: Literal["drink", "food", "modifier"] = "drink"):
        return flow.edit(phone_hash, {"op": "add_item", "item": item, "usd": usd, "size": size, "category": category})

    def remove_item(item: str):
        return flow.edit(phone_hash, {"op": "remove_item", "item": item})

    def keep_item(item: str):
        return flow.edit(phone_hash, {"op": "keep_item", "item": item})

    def set_scope(scope: Literal["full", "partial"]):
        return flow.set_scope(phone_hash, scope)

    def show_more():
        return flow.show_more(phone_hash)

    def confirm_update():
        return flow.confirm(phone_hash)

    def cancel_update():
        return flow.cancel(phone_hash)

    tools = [
        _tool(set_price, "Set an item's price in dollars. size: which size, when the item has several."),
        _tool(rename_item, "Fix an item's name."),
        _tool(add_item, "Add an item that is missing. usd: its price, if the owner gave one."),
        _tool(remove_item, "Take an item off the menu (also for things that are not menu items, like decoration)."),
    ]
    if draft is None:
        return [
            _tool(get_my_menu, "Show the owner their current menu. contains: only items matching this word."),
            _tool(get_insights, "This week's numbers for the owner's café: searches, picks and menu views."),
        ] + tools
    tools += [
        _tool(rename_size, 'Rename a size, for example old_size "Small" to new_size "12oz". '
                           "item: only for that item; leave out to rename it on every item."),
        _tool(show_more, "Show the next items the owner should check."),
        _tool(confirm_update, "Save the update. ONLY when the owner clearly says it is correct or says to save."),
        _tool(cancel_update, "Drop the update without saving, when the owner says to cancel."),
    ]
    if draft.scope is None:
        tools.append(_tool(set_scope, 'The owner said whether the photo shows the "full" menu or only "partial" (part of it).'))
    if draft.scope == "full":
        tools.append(_tool(keep_item, "Keep an item that is not in the photo on the menu."))
    return tools


# ---------- the reply of last resort ----------

def template_reply(calls):
    """A reply built straight from tool results, for when the model's own
    reply fails the grounding check twice. None when no result can be used."""
    for call in reversed(calls):
        result = call.result
        if not isinstance(result, dict) or result.get("error"):
            continue
        if call.name == "search_cafes" and result.get("results"):
            lines = ["Here's what I found:"]
            for number, cafe in enumerate(result["results"][:3], 1):
                line = f"{number}. {cafe['name']}: {cafe.get('summary') or cafe.get('vibe') or ''}".rstrip(": ")
                if cafe.get("matching_items"):
                    item = cafe["matching_items"][0]
                    line += f" Has {item['item']}" + (f" ({item['prices']})." if item["prices"] else ".")
                if cafe.get("miles") is not None:
                    line += f" {cafe['miles']} miles away."
                lines.append(line)
            return "\n".join(lines)
        if call.name == "get_menu" and result.get("items"):
            shown = result["items"][:8]
            lines = [f"{result['name']}'s menu:"] + [f"- {item['item']}: {item['prices']}" for item in shown]
            if len(result["items"]) > len(shown):
                lines.append("Ask me about a specific item for more.")
            return "\n".join(lines)
        if call.name == "get_hours" and result.get("hours"):
            hours = ", ".join(f"{day.capitalize()} {span}" for day, span in result["hours"].items())
            state = "open" if result.get("open_now") else "closed"
            return f"{result['name']} is {state} right now. Hours: {hours}."
        if call.name == "distance" and result.get("miles") is not None:
            return f"{result['cafe']} is {result['miles']} miles from {result['from']}."
    return None
