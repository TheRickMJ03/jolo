"""POST /v1/turn: the iMessage bridge's contract (docs/contracts.md section 2).

These tests send the same JSON the bridge sends (spectrum-archive-app/src/jolo/types.ts)
and check the actions that come back, over HTTP with FastAPI's test client.
The model and the menu reader are faked: nothing is downloaded and no server is needed.
"""

import base64

import pytest
from fastapi.testclient import TestClient

from agent_helpers import (CUSTOMER, OWNER, FakeModel, FakeReader, HeldExecutor, item, make_brain, result,
                           unreadable)
from api.app import create_app
from api.turn import MAX_PHOTOS
from jolo_agent import messages
from jolo_agent.tools import EDIT_TOOLS

PHOTO = {"name": "menu.heic", "mime_type": "image/heic",
         "data_base64": base64.b64encode(b"pretend menu photo").decode()}

# What a good read of Barbara's menu shows: Cortado repriced, Mocha new, Latte and the empanada not in the photo.
GOOD_READ = result(item("Cortado", 4.75), item("Mocha", 5.00, confidence=0.55))


def turn_client(tmp_path, *reads, model=None, executor=None, timeout=None):
    brain = make_brain(tmp_path, model=model, reader=FakeReader(*reads), executor=executor)
    brain.settings["api"]["turn_poll_seconds"] = 0.01
    if timeout is not None:
        brain.settings["api"]["turn_timeout_seconds"] = timeout
    client = TestClient(create_app(brain))
    return client, brain


def send(client, handle, event, role="owner"):
    response = client.post("/v1/turn", json={"conversation_id": f"any;-;{handle}", "platform": "imessage",
                                             "sender": {"handle": handle, "name": "Barbara", "role": role},
                                             "event": event})
    return response


def actions(client, handle, event, role="owner"):
    response = send(client, handle, event, role)
    assert response.status_code == 200, response.text
    return response.json()["actions"]


def photo_message(*photos):
    return {"type": "message", "text": "", "photos": list(photos or [PHOTO])}


def types(found):
    return [action["type"] for action in found]


def open_update(client, scope="partial"):
    """The bridge's first two steps: a photo, then the owner's answer to the scope question."""
    assert types(actions(client, OWNER, photo_message())) == ["ask_scope"]
    return actions(client, OWNER, {"type": "scope", "scope": scope})


# ---------- the happy path ----------

def test_photo_scope_confirm_saves_a_new_version(tmp_path):
    client, brain = turn_client(tmp_path, GOOD_READ)
    proposal = open_update(client, "partial")
    assert types(proposal) == ["confirm_changes"]
    assert proposal[0]["cafe_name"] == "Barbara's"
    changes = proposal[0]["changes"]
    assert [added["item"] for added in changes["added"]] == ["Mocha"]
    assert changes["added"][0]["confidence"] == 0.55                       # the bridge sorts by this
    assert changes["price_changes"] == [{"item": "Cortado", "size": None, "old_usd": 4.5, "new_usd": 4.75}]
    assert changes["removed"] == []                                         # partial: nothing is removed
    assert brain.store.get_cafe("barbaras").current_version == 1            # nothing saved yet

    assert actions(client, OWNER, {"type": "confirm", "confirmed": True}) == [
        {"type": "menu_updated", "cafe_name": "Barbara's", "version": 2}]
    names = {menu_item.item for menu_item in brain.store.get_current_menu("barbaras").items}
    assert names == {"Cortado", "Latte", "Cheese Empanada", "Mocha"}
    assert list(brain.store._list("drafts")) == []                          # the update is closed


def test_full_scope_lists_what_the_photo_lacks_as_removed(tmp_path):
    client, _brain = turn_client(tmp_path, GOOD_READ)
    proposal = open_update(client, "full")
    assert sorted(proposal[0]["changes"]["removed"]) == ["Cheese Empanada", "Latte"]


def test_ask_scope_comes_back_before_the_read_finishes(tmp_path):
    held = HeldExecutor()
    client, _brain = turn_client(tmp_path, GOOD_READ, executor=held)
    assert types(actions(client, OWNER, photo_message())) == ["ask_scope"]      # at once: the read is held
    assert len(held.jobs) == 1
    held.run()                                                                   # the read finishes
    proposal = actions(client, OWNER, {"type": "scope", "scope": "partial"})
    assert types(proposal) == ["confirm_changes"]


def test_scope_answered_while_the_read_is_still_running_waits_for_it(tmp_path):
    held = HeldExecutor()
    client, _brain = turn_client(tmp_path, GOOD_READ, executor=held, timeout=5)
    actions(client, OWNER, photo_message())
    import threading
    threading.Timer(0.1, held.run).start()                                       # the read ends 100 ms later
    proposal = actions(client, OWNER, {"type": "scope", "scope": "partial"})
    assert types(proposal) == ["confirm_changes"]


def test_a_read_that_takes_too_long_is_a_504_and_the_owner_can_answer_again(tmp_path):
    held = HeldExecutor()
    client, _brain = turn_client(tmp_path, GOOD_READ, executor=held, timeout=0.05)
    actions(client, OWNER, photo_message())
    assert send(client, OWNER, {"type": "scope", "scope": "partial"}).status_code == 504
    held.run()
    assert types(actions(client, OWNER, {"type": "scope", "scope": "partial"})) == ["confirm_changes"]


def test_a_second_photo_of_the_same_menu_is_merged(tmp_path):
    second = result(item("Latte", 5.25), item("Scone", 3.00, category="food"))
    client, _brain = turn_client(tmp_path, GOOD_READ, second)
    open_update(client, "partial")
    merged = actions(client, OWNER, photo_message())                             # scope is known: waits, then re-proposes
    assert types(merged) == ["confirm_changes"]
    changes = merged[0]["changes"]
    assert sorted(added["item"] for added in changes["added"]) == ["Mocha", "Scone"]
    assert sorted(change["item"] for change in changes["price_changes"]) == ["Cortado", "Latte"]


def test_added_items_are_ordered_dishes_first_when_the_reader_is_equally_sure_of_everything(tmp_path):
    """The bridge sorts by confidence with a stable sort and shows six lines: on a tie, our order is the owner's."""
    read = result(item("Cheese", category="modifier"), item("Ham", category="modifier"),
                  item("Mocha", 5.00, category="drink"), item("Gnocchi", category="food"),
                  item("Scone", 3.00, category="food"), item("Unsure Tea", 4.00, confidence=0.4),
                  item("Cortado", 4.50), item("Latte", 5.00), item("Cheese Empanada", 3.50, category="food"))
    client, _brain = turn_client(tmp_path, read)
    proposal = open_update(client)
    order = [added["item"] for added in proposal[0]["changes"]["added"]]
    assert order == ["Unsure Tea",              # least confident first
                     "Gnocchi",                 # then dishes with no price
                     "Mocha", "Scone",          # then priced dishes, in menu order
                     "Cheese", "Ham"]           # add-ons last


def test_several_photos_in_one_message_are_read_and_merged_once(tmp_path):
    second = result(item("Scone", 3.00, category="food"))
    client, _brain = turn_client(tmp_path, GOOD_READ, second)
    assert types(actions(client, OWNER, photo_message(PHOTO, PHOTO))) == ["ask_scope"]
    proposal = actions(client, OWNER, {"type": "scope", "scope": "partial"})
    assert sorted(added["item"] for added in proposal[0]["changes"]["added"]) == ["Mocha", "Scone"]


# ---------- corrections and cancelling ----------

def test_correction_changes_the_proposal_and_is_never_saved_until_confirm(tmp_path):
    model = FakeModel([("set_price", {"item": "Mocha", "usd": 5.50})])
    client, brain = turn_client(tmp_path, GOOD_READ, model=model)
    open_update(client)
    again = actions(client, OWNER, {"type": "correction", "text": "no, the mocha is 5.50"})
    assert types(again) == ["confirm_changes"]
    assert again[0]["changes"]["added"][0]["prices"] == [{"size": None, "usd": 5.5}]
    assert brain.store.get_cafe("barbaras").current_version == 1
    offered = model.seen[0][1]
    assert offered and set(offered) <= EDIT_TOOLS                                # it can't save or cancel from here
    assert actions(client, OWNER, {"type": "confirm", "confirmed": True})[0]["version"] == 2
    mocha = next(menu_item for menu_item in brain.store.get_current_menu("barbaras").items if menu_item.item == "Mocha")
    assert mocha.prices[0].usd == 5.5


def test_a_fix_that_cannot_be_applied_is_explained_and_the_proposal_is_sent_again(tmp_path):
    model = FakeModel([("set_price", {"item": "Zebra Latte", "usd": 5.50})])
    client, _brain = turn_client(tmp_path, GOOD_READ, model=model)
    open_update(client)
    again = actions(client, OWNER, {"type": "correction", "text": "the zebra latte is 5.50"})
    assert types(again) == ["say", "confirm_changes"]
    assert "Zebra Latte" in again[0]["text"] or "zebra" in again[0]["text"].lower()


def test_correction_with_no_update_open_says_there_is_nothing_to_fix(tmp_path):
    client, _brain = turn_client(tmp_path)
    found = actions(client, OWNER, {"type": "correction", "text": "the cortado is 4.50"})
    assert found == [{"type": "say", "text": messages.NOTHING_TO_CONFIRM}]


def test_confirm_false_cancels_and_changes_nothing(tmp_path):
    client, brain = turn_client(tmp_path, GOOD_READ)
    open_update(client)
    assert actions(client, OWNER, {"type": "confirm", "confirmed": False}) == [{"type": "cancelled"}]
    assert brain.store.get_cafe("barbaras").current_version == 1
    assert list(brain.store._list("drafts")) == []


# ---------- the reader fails ----------

def test_a_read_that_fails_at_once_answers_the_photo_itself(tmp_path):
    """A refused connection fails in milliseconds: no point asking about scope first."""
    client, _brain = turn_client(tmp_path, unreadable("blurry"))
    assert actions(client, OWNER, photo_message()) == [{"type": "unreadable_photo", "reason": "blurry"}]


def test_a_model_error_is_reader_down(tmp_path):
    client, _brain = turn_client(tmp_path, unreadable("model_error: connection refused"))
    assert actions(client, OWNER, photo_message()) == [{"type": "reader_down"}]


def test_a_read_that_fails_after_ask_scope_is_reported_on_the_scope_answer(tmp_path):
    held = HeldExecutor()
    client, brain = turn_client(tmp_path, unreadable("blurry"), executor=held)
    assert types(actions(client, OWNER, photo_message())) == ["ask_scope"]
    held.run()                                                                   # the read fails while the owner is answering
    assert actions(client, OWNER, {"type": "scope", "scope": "full"}) == [
        {"type": "unreadable_photo", "reason": "blurry"}]
    assert actions(client, OWNER, {"type": "scope", "scope": "full"}) == [         # and the failure is reported only once
        {"type": "say", "text": messages.NOTHING_TO_CONFIRM}]


def test_reader_down_after_ask_scope_is_reported_on_the_scope_answer(tmp_path):
    held = HeldExecutor()
    client, _brain = turn_client(tmp_path, unreadable("model_error: down"), executor=held)
    actions(client, OWNER, photo_message())
    held.run()
    assert actions(client, OWNER, {"type": "scope", "scope": "partial"}) == [{"type": "reader_down"}]


def test_a_photo_with_no_changes_says_so(tmp_path):
    same = result(item("Cortado", 4.50), item("Latte", 5.00), item("Cheese Empanada", 3.50, category="food"))
    client, brain = turn_client(tmp_path, same)
    actions(client, OWNER, photo_message())
    found = actions(client, OWNER, {"type": "scope", "scope": "full"})
    assert found == [{"type": "say", "text": messages.NO_CHANGES}]
    assert brain.store.get_cafe("barbaras").current_version == 1


def test_scope_with_no_update_open_starts_over(tmp_path):
    client, _brain = turn_client(tmp_path)
    assert actions(client, OWNER, {"type": "scope", "scope": "full"}) == [
        {"type": "say", "text": messages.NOTHING_TO_CONFIRM}]


# ---------- who is allowed ----------

@pytest.mark.parametrize("event", [
    photo_message(),
    {"type": "scope", "scope": "full"},
    {"type": "confirm", "confirmed": True},
    {"type": "correction", "text": "the cortado is 0.01"},
])
def test_a_handle_that_owns_no_cafe_gets_not_owner_whatever_its_role(tmp_path, event):
    client, brain = turn_client(tmp_path, GOOD_READ)
    assert actions(client, CUSTOMER, event, role="owner") == [{"type": "not_owner"}]     # "role" is not trusted
    assert brain.store.get_cafe("barbaras").current_version == 1


def test_a_non_owner_cannot_confirm_someone_elses_update(tmp_path):
    client, brain = turn_client(tmp_path, GOOD_READ)
    open_update(client)
    assert actions(client, CUSTOMER, {"type": "confirm", "confirmed": True}) == [{"type": "not_owner"}]
    assert brain.store.get_cafe("barbaras").current_version == 1


# ---------- text messages ----------

def test_a_customer_message_is_answered_with_say(tmp_path):
    client, _brain = turn_client(tmp_path, model=FakeModel("Barbara's and Curiosity are both close by."))
    found = actions(client, CUSTOMER, {"type": "message", "text": "any good cafes?", "photos": []}, role="customer")
    assert found == [{"type": "say", "text": "Barbara's and Curiosity are both close by."}]


def test_an_owner_message_without_photos_goes_to_the_brain(tmp_path):
    model = FakeModel([("set_price", {"item": "Cortado", "usd": 4.75})])
    client, brain = turn_client(tmp_path, model=model)
    found = actions(client, OWNER, {"type": "message", "text": "the cortado is 4.75 now", "photos": []})
    assert types(found) == ["say"] and brain.store.get_cafe("barbaras").current_version == 1
    assert types(actions(client, OWNER, {"type": "message", "text": "yes", "photos": []})) == ["say"]
    assert brain.store.get_cafe("barbaras").current_version == 2


@pytest.mark.parametrize("handle", ["terminal-user", "someone@icloud.com", "+19085551234"])
def test_any_kind_of_handle_works(tmp_path, handle):
    client, _brain = turn_client(tmp_path, model=FakeModel("Hello!"))
    assert actions(client, handle, {"type": "message", "text": "hi", "photos": []}, role="customer") == [
        {"type": "say", "text": "Hello!"}]


# ---------- malformed requests ----------

def test_too_many_photos_a_non_image_and_bad_base64_are_rejected(tmp_path):
    client, _brain = turn_client(tmp_path, GOOD_READ)
    assert send(client, OWNER, photo_message(*[PHOTO] * (MAX_PHOTOS + 1))).status_code == 422
    assert send(client, OWNER, photo_message({**PHOTO, "mime_type": "application/pdf"})).status_code == 422
    assert send(client, OWNER, photo_message({**PHOTO, "data_base64": "***not base64***"})).status_code == 422


def test_unknown_event_types_and_missing_fields_are_rejected(tmp_path):
    client, _brain = turn_client(tmp_path)
    assert send(client, OWNER, {"type": "shrug"}).status_code == 422
    assert send(client, OWNER, {"type": "scope"}).status_code == 422
    assert client.post("/v1/turn", json={"conversation_id": "x"}).status_code == 422
    assert send(client, "  ", {"type": "message", "text": "hi", "photos": []}).status_code == 422


# ---------- auth ----------

def test_bearer_token_and_api_key_are_both_accepted_when_set(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_TOKEN", "bridge-secret")
    monkeypatch.setenv("JOLO_API_KEY", "other-secret")
    client, _brain = turn_client(tmp_path, model=FakeModel("a", "b", "c"))
    body = {"conversation_id": "x", "sender": {"handle": CUSTOMER}, "event": {"type": "message", "text": "hi"}}
    assert client.post("/v1/turn", json=body).status_code == 401
    assert client.post("/v1/turn", json=body, headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert client.post("/v1/turn", json=body, headers={"Authorization": "Bearer bridge-secret"}).status_code == 200
    assert client.post("/v1/turn", json=body, headers={"X-Jolo-Key": "other-secret"}).status_code == 200
    assert client.get("/health").status_code == 401


def test_no_token_set_means_open_on_localhost(tmp_path, monkeypatch):
    monkeypatch.delenv("AGENT_TOKEN", raising=False)
    monkeypatch.delenv("JOLO_API_KEY", raising=False)
    client, _brain = turn_client(tmp_path)
    assert client.get("/health").status_code == 200
