"""Tests for the store, the menu operations and the owner's menu-update flow.
The reader is faked, so no server is needed."""

import pytest

from agent_helpers import (OWNER, FakeReader, HeldExecutor, InlineExecutor, config, item, result,
                           seeded_store, unreadable)
from menu_reader.schema import Price
from jolo_agent import messages
from jolo_agent.flow import MenuUpdateFlow
from jolo_agent.menu_ops import (EditError, apply_op, changes_between, final_items, find_item, has_generic_sizes,
                                 items_to_check)
from jolo_agent.store import MemoryStore, hash_phone

PHONE = hash_phone(OWNER)


def names(items):
    return [entry.item for entry in items]


def make_flow(*results, store=None, executor=None):
    store = store or seeded_store()
    sent = []
    flow = MenuUpdateFlow(store, config(), reader=FakeReader(*results), executor=executor or InlineExecutor(),
                          send=lambda phone_hash, text: sent.append(text))
    return flow, store, sent


# ---------- store ----------

def test_hash_phone_ignores_formatting_and_hides_the_number():
    assert hash_phone("+1 (609) 555-0100") == hash_phone("6095550100") == hash_phone("16095550100")
    assert hash_phone("6095550100") != hash_phone("6095550101")
    assert "609" not in hash_phone("6095550100")
    with pytest.raises(ValueError):
        hash_phone("no digits")


def test_save_menu_version_keeps_history():
    store = seeded_store()
    second = store.save_menu_version("barbaras", [item("Cortado", 4.75)], scope="partial")
    assert second.version == 2
    assert store.get_cafe("barbaras").current_version == 2
    assert store.get_current_menu("barbaras").items[0].prices[0].usd == 4.75
    assert store.get_menu_version("barbaras", 1).items[0].prices[0].usd == 4.50      # version 1 is still there
    assert [version.version for version in store.list_menu_versions("barbaras")] == [1, 2]


def test_save_menu_version_unknown_cafe():
    with pytest.raises(KeyError):
        seeded_store().save_menu_version("nowhere", [])


def test_find_cafe_by_owner():
    store = seeded_store()
    assert store.find_cafe_by_owner(PHONE).cafe_id == "barbaras"
    assert store.find_cafe_by_owner(hash_phone("6095550199")) is None


def test_memory_store_survives_a_restart(tmp_path):
    path = tmp_path / "store.json"
    first = MemoryStore(path)
    for cafe in seeded_store().list_cafes():
        first.upsert_cafe(cafe.model_copy(update={"current_version": 0}))
    first.save_menu_version("barbaras", [item("Açaí", 9.0)])
    again = MemoryStore(path)
    assert again.get_current_menu("barbaras").items[0].item == "Açaí"


def test_returned_documents_are_copies():
    store = seeded_store()
    store.get_current_menu("barbaras").items.clear()
    assert len(store.get_current_menu("barbaras").items) == 3


# ---------- menu_ops ----------

def test_find_item_exact_fuzzy_and_ambiguous():
    menu = [item("Latte"), item("Iced Latte"), item("Caramel Latte"), item("Cortado aka Garoto or Pingado")]
    assert find_item(menu, "latte") == (0, [])                       # the exact name wins over longer ones
    assert find_item(menu, "iced late") == (1, [])                   # a typo
    assert find_item(menu, "cortado") == (3, [])                     # part of a long name
    index, candidates = find_item([item("Iced Latte"), item("Caramel Latte")], "latte")
    assert index is None and candidates == ["Iced Latte", "Caramel Latte"]
    assert find_item(menu, "pizza") == (None, [])


def test_a_longer_name_is_a_different_item_not_a_match_for_a_shorter_one():
    """"Oat Latte" is not on a menu that only has "Latte": repricing Latte for it would be a silent mistake."""
    only_latte = [item("Latte", 5.00), item("Cortado", 4.50)]
    assert find_item(only_latte, "oat latte") == (None, [])
    assert find_item(only_latte, "zebra latte") == (None, [])
    assert find_item(only_latte, "matcha latte") == (None, [])
    assert find_item([item("Oat Latte")], "latte") == (0, [])         # the other direction is still fine
    with pytest.raises(EditError):
        apply_op([item("Latte", 5.00)], [], {"op": "set_price", "item": "Oat Latte", "usd": 5.50})


def test_set_price_single_and_by_size():
    draft = [item("Cortado", 4.50, confidence=0.4),
             item("Latte", prices=[Price(size="Small", usd=4.0), Price(size="Large", usd=5.0)])]
    text, before, after = apply_op(draft, [], {"op": "set_price", "item": "cortado", "usd": 4.75})
    assert draft[0].prices[0].usd == 4.75 and draft[0].confidence == 1.0
    assert before["prices"][0]["usd"] == 4.50 and after["prices"][0]["usd"] == 4.75
    assert "$4.75" in text

    with pytest.raises(EditError, match="several sizes"):
        apply_op(draft, [], {"op": "set_price", "item": "latte", "usd": 4.25})
    apply_op(draft, [], {"op": "set_price", "item": "latte", "usd": 4.25, "size": "small"})
    assert [price.usd for price in draft[1].prices] == [4.25, 5.0]


def test_edit_of_an_item_the_photo_did_not_show_copies_it_from_the_stored_menu():
    draft, stored = [], [item("Latte", 5.00)]
    apply_op(draft, stored, {"op": "set_price", "item": "latte", "usd": 5.25})
    assert draft[0].prices[0].usd == 5.25
    assert stored[0].prices[0].usd == 5.00           # the stored menu is not touched


def test_rename_size_everywhere():
    draft = [item("Latte", prices=[Price(size="Small", usd=4.0), Price(size="Large", usd=5.0)]),
             item("Mocha", prices=[Price(size="small", usd=4.5)])]
    assert has_generic_sizes(draft)
    apply_op(draft, [], {"op": "rename_size", "old_size": "small", "new_size": "12oz"})
    assert [price.size for entry in draft for price in entry.prices] == ["12oz", "Large", "12oz"]
    with pytest.raises(EditError):
        apply_op(draft, [], {"op": "rename_size", "old_size": "venti", "new_size": "20oz"})


def test_unknown_and_ambiguous_items_ask_the_owner():
    with pytest.raises(EditError, match="can't find"):
        apply_op([item("Latte", 5.0)], [], {"op": "set_price", "item": "pizza", "usd": 9})
    with pytest.raises(EditError, match="Which one"):
        apply_op([item("Iced Latte", 5.0), item("Caramel Latte", 5.5)], [], {"op": "set_price", "item": "latte", "usd": 9})


def test_final_items_partial_keeps_what_the_photo_does_not_show():
    stored = [item("Cortado", 4.50), item("Latte", 5.00), item("Empanada", 3.50)]
    photo = [item("Cortado", 4.75), item("Mocha", 5.50)]
    final = final_items(stored, photo, "partial")
    assert names(final) == ["Cortado", "Latte", "Empanada", "Mocha"]
    assert final[0].prices[0].usd == 4.75
    changes = changes_between(stored, final)
    assert changes.new_items == ["Mocha"] and changes.missing_from_photo == []
    assert [(change.old_usd, change.new_usd) for change in changes.price_changes] == [(4.50, 4.75)]


def test_final_items_full_drops_missing_unless_kept():
    stored = [item("Cortado", 4.50), item("Latte", 5.00), item("Empanada", 3.50)]
    photo = [item("Cortado", 4.75), item("Mocha", 5.50)]
    assert names(final_items(stored, photo, "full")) == ["Cortado", "Mocha"]
    kept = final_items(stored, photo, "full", [{"op": "keep_item", "item": "Latte"}])
    assert names(kept) == ["Cortado", "Mocha", "Latte"]
    assert changes_between(stored, kept).missing_from_photo == ["Empanada"]


def test_final_items_removed_and_priceless():
    stored = [item("Cortado", 4.50), item("Latte", 5.00)]
    photo = [item("Cortado"), item("Wall Art", 0.0)]              # no price read for Cortado; a decoration
    final = final_items(stored, photo, "partial", [{"op": "remove_item", "item": "Wall Art"},
                                                   {"op": "remove_item", "item": "Latte"}])
    assert names(final) == ["Cortado"]
    assert final[0].prices[0].usd == 4.50                         # a lost price is never read as a change


def test_items_to_check_least_confident_first():
    stored = [item("Cortado", 4.50), item("Latte", 5.00)]
    final = [item("Cortado", 4.75, confidence=0.9), item("Latte", 5.00, confidence=0.1),
             item("Mocha", 5.50, confidence=0.4), item("Flat White", 4.80, confidence=0.7)]
    order = items_to_check(final, changes_between(stored, final), first_menu=False)
    assert names(order) == ["Mocha", "Flat White", "Cortado"]      # Latte didn't change: not asked about
    assert names(items_to_check(final, changes_between([], final), first_menu=True))[0] == "Latte"


# ---------- flow ----------

def test_photo_starts_a_read_and_asks_the_scope():
    executor = HeldExecutor()
    flow, store, sent = make_flow(result(item("Cortado", 4.75)), executor=executor)
    assert flow.start_read(PHONE, b"photo") == [messages.READING, messages.ASK_SCOPE]
    assert store.get_draft(PHONE).state == "reading" and sent == []     # replied before the read ran
    assert flow.confirm(PHONE) == messages.STILL_READING
    executor.run()
    assert store.get_draft(PHONE).state == "awaiting_scope"
    assert "Is this your full menu" in sent[0]


def test_photo_from_a_number_without_a_cafe():
    flow, _store, _sent = make_flow()
    assert flow.start_read(hash_phone("6095550199"), b"photo") == [messages.NOT_AN_OWNER]


def test_partial_update_ignores_missing_items_and_saves_only_on_confirm():
    flow, store, sent = make_flow(result(item("Cortado", 4.75, confidence=0.9), item("Mocha", 5.50, confidence=0.4)))
    flow.start_read(PHONE, b"photo")
    summary = flow.set_scope(PHONE, "partial")
    assert "1 new item, 1 price change" in summary and "take them off" not in summary
    assert summary.index("Mocha: $5.50") < summary.index("Cortado: $4.75")         # least confident first
    assert store.get_cafe("barbaras").current_version == 1                           # nothing saved yet

    assert "version 2" in flow.confirm(PHONE)
    menu = store.get_current_menu("barbaras")
    assert names(menu.items) == ["Cortado", "Latte", "Cheese Empanada", "Mocha"]     # Latte and Empanada kept
    assert menu.scope == "partial" and menu.source == "photo" and menu.changes.new_items == ["Mocha"]
    assert store.get_draft(PHONE) is None
    assert store.get_menu_version("barbaras", 1) is not None
    assert [event.kind for event in store.list_events()] == ["menu_update"]


def test_full_update_lists_removals_and_the_owner_can_keep_one():
    flow, store, _sent = make_flow(result(item("Cortado", 4.50), item("Mocha", 5.50)))
    flow.start_read(PHONE, b"photo")
    summary = flow.set_scope(PHONE, "full")
    assert "take them off the menu: Latte, Cheese Empanada" in summary
    assert "keep Latte" in flow.edit(PHONE, {"op": "keep_item", "item": "latte"})
    flow.confirm(PHONE)
    assert names(store.get_current_menu("barbaras").items) == ["Cortado", "Mocha", "Latte"]


def test_scope_given_while_reading_then_summary_arrives_later():
    executor = HeldExecutor()
    flow, _store, sent = make_flow(result(item("Mocha", 5.50)), executor=executor)
    flow.start_read(PHONE, b"photo")
    assert "Still reading" in flow.set_scope(PHONE, "partial")
    executor.run()
    assert len(sent) == 1 and "Mocha: $5.50" in sent[0] and 'Reply "yes"' in sent[0]


def test_unreadable_photo_and_reader_down_get_different_messages():
    flow, store, sent = make_flow(unreadable("blurry"), unreadable("model_error: Could not reach http://localhost:8000"))
    flow.start_read(PHONE, b"photo")
    assert sent == [messages.PHOTO_UNREADABLE] and store.get_draft(PHONE) is None
    flow.start_read(PHONE, b"photo")
    assert sent[-1] == messages.READER_DOWN


def test_a_reader_that_raises_does_not_lose_the_conversation():
    def broken(photo):
        raise RuntimeError("boom")
    store = seeded_store()
    sent = []
    flow = MenuUpdateFlow(store, config(), reader=broken, executor=InlineExecutor(),
                          send=lambda phone_hash, text: sent.append(text))
    flow.start_read(PHONE, b"photo")
    assert sent == [messages.READER_DOWN] and store.get_draft(PHONE) is None


def test_photo_with_no_items_counts_as_unreadable():
    flow, _store, sent = make_flow(result())
    flow.start_read(PHONE, b"photo")
    assert sent == [messages.PHOTO_UNREADABLE]


def test_several_photos_are_merged_once():
    executor = HeldExecutor()
    flow, store, sent = make_flow(result(item("Cortado", 4.75), item("Mocha", 5.50)),
                                  result(item("Mocha", 5.50), item("Flat White", 4.80)),
                                  unreadable("blurry"), executor=executor)
    for photo in (b"one", b"two", b"three"):
        flow.start_read(PHONE, photo)
    flow.set_scope(PHONE, "full")
    executor.run()
    assert "I couldn't read 1 photo" in sent[0]
    assert names(store.get_draft(PHONE).items) == ["Cortado", "Mocha", "Flat White"]     # Mocha once
    assert "2 new items, 1 price change, 2 removed" in sent[1]
    flow.confirm(PHONE)
    assert names(store.get_current_menu("barbaras").items) == ["Cortado", "Mocha", "Flat White"]


def test_owner_fixes_are_applied_logged_and_survive_another_photo():
    flow, store, sent = make_flow(result(item("Cortado", 4.57, confidence=0.3), item("Wall Art", 1.0)),
                                  result(item("Mocha", 5.50)))
    flow.start_read(PHONE, b"one")
    flow.set_scope(PHONE, "partial")
    assert "$4.75" in flow.edit(PHONE, {"op": "set_price", "item": "cortado", "usd": 4.75})
    flow.edit(PHONE, {"op": "remove_item", "item": "wall art"})
    assert "can't find" in flow.edit(PHONE, {"op": "set_price", "item": "pizza", "usd": 9})
    corrections = store.list_corrections("barbaras")
    assert [correction.op["op"] for correction in corrections] == ["set_price", "remove_item"]
    assert corrections[0].before["prices"][0]["usd"] == 4.57 and corrections[0].after["prices"][0]["usd"] == 4.75

    flow.start_read(PHONE, b"two")                    # a second photo: everything is merged again
    assert "Mocha" in sent[-1]
    flow.confirm(PHONE)
    menu = {entry.item: entry for entry in store.get_current_menu("barbaras").items}
    assert menu["Cortado"].prices[0].usd == 4.75 and "Wall Art" not in menu and "Mocha" in menu


def test_change_described_in_words_without_a_photo():
    flow, store, _sent = make_flow()
    assert "$4.75" in flow.edit(PHONE, {"op": "set_price", "item": "cortado", "usd": 4.75})
    assert store.get_cafe("barbaras").current_version == 1
    assert "1 price change" in flow.status(PHONE)
    flow.confirm(PHONE)
    menu = store.get_current_menu("barbaras")
    assert menu.source == "owner_text" and menu.items[0].prices[0].usd == 4.75 and len(menu.items) == 3
    assert store.list_corrections() == []             # not a correction of the reader


def test_nothing_changed():
    flow, store, _sent = make_flow(result(item("Cortado", 4.50), item("Latte", 5.00)))
    flow.start_read(PHONE, b"photo")
    assert flow.set_scope(PHONE, "partial").endswith(messages.NO_CHANGES)
    assert store.get_draft(PHONE) is None and store.get_cafe("barbaras").current_version == 1


def test_cancel_then_a_late_read_is_ignored():
    executor = HeldExecutor()
    flow, store, sent = make_flow(result(item("Mocha", 5.50)), executor=executor)
    flow.start_read(PHONE, b"photo")
    assert flow.cancel(PHONE) == messages.CANCELLED
    executor.run()
    assert sent == [] and store.get_draft(PHONE) is None
    assert flow.confirm(PHONE) == messages.NOTHING_TO_CONFIRM


def test_show_more_walks_through_the_items():
    photo = result(*[item(f"Drink {number}", 3.0 + number, confidence=number / 10) for number in range(8)])
    flow, _store, _sent = make_flow(photo)
    flow.start_read(PHONE, b"photo")
    summary = flow.set_scope(PHONE, "partial")
    assert "5. Drink 4" in summary and "6. Drink 5" not in summary and 'say "more"' in summary
    more = flow.show_more(PHONE)
    assert "6. Drink 5" in more and "8. Drink 7" in more and 'say "more"' not in more
    assert flow.show_more(PHONE).startswith(messages.NO_MORE)


def test_first_menu_for_a_cafe_and_sizes_note():
    store = seeded_store()
    store.upsert_cafe(store.get_cafe("curiosity").model_copy(update={"owner_phone_hash": PHONE, "current_version": 0}))
    store.upsert_cafe(store.get_cafe("barbaras").model_copy(update={"owner_phone_hash": None}))
    photo = result(item("Latte", prices=[Price(size="Small", usd=4.0), Price(size="Large", usd=5.0)]), hours="7am - 3pm")
    flow, store, _sent = make_flow(photo, store=store)
    flow.start_read(PHONE, b"photo")
    summary = flow.set_scope(PHONE, "full")
    assert "first menu" in summary and messages.SIZES_NOTE in summary
    assert flow.confirm(PHONE) == "Your menu is saved: 1 items."
    assert store.get_cafe("curiosity").hours_text == "7am - 3pm"
