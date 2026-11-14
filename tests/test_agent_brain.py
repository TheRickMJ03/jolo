"""Tests for the agent loop, the grounding check and message routing.
The model is faked, so no server is needed."""

import httpx
import openai
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from agent_helpers import CUSTOMER, OWNER, FakeModel, FakeReader, HeldExecutor, item, make_brain, result
from jolo_agent import messages
from jolo_agent.agent import ChatModel, ModelDown, describe_tool, parse_actions, run_turn, to_json_mode
from jolo_agent.brain import NO_GROUNDED_ANSWER, OWNER_HELP
from jolo_agent.grounding import ungrounded_facts
from jolo_agent.insights import owner_summary, weekly_counts
from jolo_agent.intents import quick_intent
from jolo_agent.store import Draft, hash_phone
from jolo_agent.tools import Context, customer_tools, find_cafe_by_phone, owner_tools, resolve_cafe, template_reply


# ---------- grounding ----------

def test_grounded_reply_passes():
    evidence = ['{"items": [{"item": "Cortado", "prices": "$4.50"}], "miles": 0.4, "hours": {"mon": "07:00-15:00"}}']
    reply = "Barbara's has a cortado for $4.50, 0.4 miles away. Open 7am to 3pm."
    assert ungrounded_facts(reply, evidence) == []


def test_invented_price_time_and_distance_are_caught():
    evidence = ['{"items": [{"item": "Cortado", "prices": "$4.50"}], "hours": {"mon": "07:00-15:00"}}']
    assert ungrounded_facts("The cortado is $4.75.", evidence) == ["$4.75"]
    assert ungrounded_facts("They close at 9pm.", evidence) == ["9pm"]
    assert ungrounded_facts("It's 2 miles from you.", evidence) == ["2 miles"]
    assert ungrounded_facts("About 5 dollars.", evidence) == ["5 dollars"]


def test_the_users_own_numbers_and_plain_counts_are_fine():
    assert ungrounded_facts("Nothing under $5, sorry.", ["anything under $5?"]) == []
    assert ungrounded_facts("Here are 3 cafés with 2 matcha drinks each.", ["{}"]) == []


def test_times_compare_across_formats():
    assert ungrounded_facts("Open 7:30 a.m. until 15:00.", ['"sat": "07:30-15:00"']) == []
    assert ungrounded_facts("Open until 3:30pm.", ['"sat": "07:30-15:00"']) == ["3:30pm"]


# ---------- JSON actions ----------

def test_parse_actions_understands_each_format():
    assert parse_actions('{"calls": [{"tool": "get_menu", "args": {"cafe_id": "barbaras"}}]}') == \
        ([{"name": "get_menu", "args": {"cafe_id": "barbaras"}}], None)
    assert parse_actions('```json\n{"tool": "show_more"}\n```') == ([{"name": "show_more", "args": {}}], None)
    assert parse_actions('<tool_call>\n{"name": "get_hours", "arguments": {"cafe_id": "x"}}\n</tool_call>') == \
        ([{"name": "get_hours", "args": {"cafe_id": "x"}}], None)
    assert parse_actions('{"reply": "Hi there!"}') == ([], "Hi there!")
    assert parse_actions("Just text.") == ([], "Just text.")


def test_to_json_mode_rewrites_tool_messages():
    brain_tools = customer_tools(Context(None, None, None, {"agent": {"timezone": "America/New_York"}}, "hash"))
    conversation = [
        SystemMessage("Be helpful."), HumanMessage("menu at barbaras?"),
        AIMessage("", tool_calls=[{"name": "get_menu", "args": {"cafe_id": "barbaras"}, "id": "1", "type": "tool_call"}]),
        ToolMessage('{"items": []}', tool_call_id="1", name="get_menu"),
    ]
    rewritten = to_json_mode(conversation, brain_tools)
    assert "- get_menu(cafe_id: string, contains?: string)" in rewritten[0].content
    assert rewritten[2].content == '{"calls": [{"tool": "get_menu", "args": {"cafe_id": "barbaras"}}]}'
    assert isinstance(rewritten[3], HumanMessage) and rewritten[3].content == 'Result of get_menu: {"items": []}'
    assert all(not getattr(message, "tool_calls", None) for message in rewritten)


def test_describe_tool_shows_choices():
    draft = Draft(phone_hash="hash", cafe_id="barbaras", state="awaiting_scope")
    tools = {tool.name: tool for tool in owner_tools(Context(None, None, None, {}, "hash"), draft)}
    assert 'set_scope(scope: "full" | "partial")' in describe_tool(tools["set_scope"])
    assert "confirm_update" in tools and "keep_item" not in tools and "get_insights" not in tools


def bad_request():
    response = httpx.Response(400, request=httpx.Request("POST", "http://localhost:8000/v1/chat/completions"))
    return openai.BadRequestError('"auto" tool choice requires --enable-auto-tool-choice', response=response, body=None)


def test_auto_mode_falls_back_to_json_when_the_server_refuses_tools(tmp_path, monkeypatch):
    brain = make_brain(tmp_path)
    brain.config["agent"]["tool_mode"] = "auto"      # config.yaml ships "json"; this tests the fallback itself
    model = ChatModel(brain.config)
    sent = []

    def fake_send(conversation, tools=None):
        sent.append((conversation, tools))
        if tools:
            raise bad_request()
        return AIMessage('{"calls": [{"tool": "get_hours", "args": {"cafe_id": "barbaras"}}]}')

    monkeypatch.setattr(model, "_send", fake_send)
    tools = customer_tools(Context(brain.store, brain.flow, brain.search, brain.config, "hash"))
    reply = model.invoke([SystemMessage("x"), HumanMessage("when is barbaras open?")], tools)
    assert model.mode == "json"
    assert reply.tool_calls[0]["name"] == "get_hours" and reply.tool_calls[0]["args"] == {"cafe_id": "barbaras"}
    assert sent[1][1] is None and "Answer with ONE JSON object" in sent[1][0][0].content


def test_connection_errors_become_model_down(tmp_path, monkeypatch):
    brain = make_brain(tmp_path)
    brain.config["agent"]["endpoint"] = "http://127.0.0.1:9/v1"       # nothing listens there
    brain.config["agent"]["timeout_seconds"] = 2
    try:
        ChatModel(brain.config).invoke([HumanMessage("hi")])
    except ModelDown as error:
        assert "127.0.0.1:9" in str(error)
    else:
        raise AssertionError("expected ModelDown")


# ---------- the loop ----------

def test_run_turn_calls_tools_then_replies(tmp_path):
    brain = make_brain(tmp_path)
    tools = customer_tools(Context(brain.store, brain.flow, brain.search, brain.config, "hash"))
    model = FakeModel([("get_menu", {"cafe_id": "Barbara's", "contains": "cortado"})], "The cortado is $4.50.")
    turn = run_turn(model, tools, [HumanMessage("how much is a cortado at barbara's?")])
    assert turn.reply == "The cortado is $4.50."
    assert turn.calls[0].result["items"] == [{"item": "Cortado", "category": "drink", "prices": "$4.50"}]
    assert isinstance(model.seen[1][0][-1], ToolMessage)             # the model saw the tool result


def test_run_turn_reports_bad_tool_calls_back_to_the_model(tmp_path):
    brain = make_brain(tmp_path)
    tools = customer_tools(Context(brain.store, brain.flow, brain.search, brain.config, "hash"))
    model = FakeModel([("get_menu", {}), ("teleport", {"to": "barbaras"})], "Sorry, I couldn't look that up.")
    turn = run_turn(model, tools, [HumanMessage("menu?")])
    assert "error" in turn.calls[0].result and "no tool named teleport" in turn.calls[1].result["error"]
    assert turn.reply.startswith("Sorry")


def test_run_turn_stops_a_model_that_never_stops_calling_tools(tmp_path):
    brain = make_brain(tmp_path)
    tools = customer_tools(Context(brain.store, brain.flow, brain.search, brain.config, "hash"))
    model = FakeModel(*[[("get_hours", {"cafe_id": "barbaras"})]] * 4)
    turn = run_turn(model, tools, [HumanMessage("hours?")], max_rounds=3)
    assert turn.reply == "" and len(turn.calls) == 3


# ---------- tools ----------

def test_find_cafe_by_phone_and_resolve_cafe(tmp_path):
    store = make_brain(tmp_path).store
    found = find_cafe_by_phone(store, OWNER)
    assert found["cafe_id"] == "barbaras" and len(found["menu"]["items"]) == 3
    assert find_cafe_by_phone(store, CUSTOMER) is None
    assert resolve_cafe(store, "barbaras").name == resolve_cafe(store, "Barbaras cafe").name == "Barbara's"
    assert resolve_cafe(store, "Starbucks") is None


def test_customer_tools_hours_distance_and_pick(tmp_path):
    brain = make_brain(tmp_path)
    tools = {tool.name: tool for tool in
             customer_tools(Context(brain.store, brain.flow, brain.search, brain.config, "hash"))}
    hours = tools["get_hours"].invoke({"cafe_id": "curiosity"})
    assert hours["hours"]["mon"] == "10:00-21:00" and hours["hours"]["tue"] == "closed"
    assert tools["distance"].invoke({"origin": "40.3509,-74.6606", "cafe_id": "barbaras"})["miles"] == 0.0
    assert "don't know where" in tools["distance"].invoke({"origin": "the moon", "cafe_id": "barbaras"})["error"]
    assert "error" in tools["get_menu"].invoke({"cafe_id": "starbucks"})

    tools["search_cafes"].invoke({"query": "matcha"})
    tools["record_pick"].invoke({"cafe_id": "Curiosity"})
    pick = brain.store.list_events("pick")[0]
    assert pick.cafe_id == "curiosity" and pick.data["query"] == "matcha" and "curiosity" in pick.data["shown"]


def test_template_reply_uses_only_tool_results(tmp_path):
    brain = make_brain(tmp_path)
    tools = customer_tools(Context(brain.store, brain.flow, brain.search, brain.config, "hash"))
    turn = run_turn(FakeModel([("search_cafes", {"query": "matcha latte"})], "x"), tools, [HumanMessage("matcha?")])
    text = template_reply(turn.calls)
    assert text.startswith("Here's what I found:") and "Curiosity" in text and "Matcha Latte ($6.00)" in text
    assert ungrounded_facts(text, [call.text for call in turn.calls]) == []
    assert template_reply([]) is None


# ---------- routing: customers ----------

def test_customer_reply_is_sent_when_grounded(tmp_path):
    model = FakeModel([("search_cafes", {"query": "matcha"})], "Try Curiosity: Matcha Latte for $6.00.")
    brain = make_brain(tmp_path, model)
    assert brain.handle_message(CUSTOMER, "where can I get matcha?") == ["Try Curiosity: Matcha Latte for $6.00."]
    assert model.seen[0][1] == ["search_cafes", "get_menu", "get_hours", "distance", "record_pick"]
    assert brain.store.list_events("search")[0].data["query"] == "matcha"


def test_ungrounded_reply_is_regenerated_once(tmp_path):
    model = FakeModel([("get_menu", {"cafe_id": "barbaras"})], "The cortado is $3.95!", "The cortado is $4.50.")
    brain = make_brain(tmp_path, model)
    assert brain.handle_message(CUSTOMER, "cortado price at barbara's?") == ["The cortado is $4.50."]
    assert "$3.95" in model.seen[2][0][-1].content                    # the problem was named


def test_twice_ungrounded_falls_back_to_the_tool_results(tmp_path):
    model = FakeModel([("get_menu", {"cafe_id": "barbaras", "contains": "cortado"})],
                      "The cortado is $3.95!", "Sorry, it's $4.10.")
    brain = make_brain(tmp_path, model)
    assert brain.handle_message(CUSTOMER, "cortado price?") == ["Barbara's's menu:\n- Cortado: $4.50"]


def test_a_fact_from_memory_with_no_tool_call_is_never_sent(tmp_path):
    model = FakeModel("Barbara's opens at 6am.", "They open at 6am, I'm sure.")
    brain = make_brain(tmp_path, model)
    assert brain.handle_message(CUSTOMER, "when does barbara's open?") == [NO_GROUNDED_ANSWER]


def test_model_down_and_customer_photo(tmp_path):
    brain = make_brain(tmp_path, FakeModel(ModelDown("no tunnel")))
    assert brain.handle_message(CUSTOMER, "hi") == [messages.MODEL_DOWN]
    assert brain.handle_message(CUSTOMER, "", [b"photo"]) == [messages.PHOTO_FROM_CUSTOMER]
    assert brain.handle_message(CUSTOMER, "   ") == [messages.EMPTY_MESSAGE]


def test_history_is_kept_per_phone(tmp_path):
    model = FakeModel("Hi! What are you in the mood for?", "Sure.")
    brain = make_brain(tmp_path, model)
    brain.handle_message(CUSTOMER, "hello")
    brain.handle_message(CUSTOMER, "thanks")
    second_call = [message.content for message in model.seen[1][0]]
    assert second_call[1:] == ["hello", "Hi! What are you in the mood for?", "thanks"]


# ---------- routing: owners ----------

def test_quick_intents():
    scope_open = Draft(phone_hash="h", cafe_id="c", state="awaiting_scope")
    confirming = Draft(phone_hash="h", cafe_id="c", state="awaiting_confirmation", scope="partial")
    assert quick_intent("Just part of it", scope_open) == ("scope", "partial")
    assert quick_intent("it's not the full menu", scope_open) == ("scope", "partial")
    assert quick_intent("That's the whole thing!", scope_open) == ("scope", "full")
    assert quick_intent("yes", scope_open) is None                    # yes to which half of the question?
    assert quick_intent("Yes, all correct", confirming) == ("confirm", None)
    assert quick_intent("more", confirming) == ("more", None)
    assert quick_intent("never mind", confirming) == ("cancel", None)
    assert quick_intent("yes but the cortado is 4.75", confirming) is None
    assert quick_intent("yes", None) is None


def test_owner_menu_update_end_to_end_without_the_model(tmp_path):
    reader = FakeReader(result(item("Cortado", 4.75, confidence=0.9), item("Mocha", 5.50, confidence=0.4)))
    brain = make_brain(tmp_path, FakeModel(), reader)
    assert brain.handle_message(OWNER, "update the menu", [b"jpeg bytes"]) == [messages.READING, messages.ASK_SCOPE]
    assert reader.photos == [b"jpeg bytes"]                           # the original bytes reach the reader
    assert "Is this your full menu" in brain.outbox.drain(OWNER)[0]
    summary = brain.handle_message(OWNER, "Just part of it")[0]
    assert "1 new item, 1 price change" in summary
    assert brain.handle_message(OWNER, "Yes, all correct") == ["Your menu is updated (version 2): 1 new item, 1 price change."]
    assert brain.store.get_cafe("barbaras").current_version == 2
    # The search index follows the new menu.
    assert any(row["name"] == "Mocha" for row in brain.search.index.rows)


def test_scope_sent_together_with_the_photo(tmp_path):
    executor = HeldExecutor()
    brain = make_brain(tmp_path, FakeModel(), FakeReader(result(item("Mocha", 5.50))), executor=executor)
    replies = brain.handle_message(OWNER, "here's my full menu", [b"photo"])
    assert replies == [messages.READING, "Got it, the full menu. Still reading…"]
    executor.run()
    assert "take them off the menu" in brain.outbox.drain(OWNER)[0]


def test_owner_fix_goes_through_the_model_and_the_tool_writes_the_reply(tmp_path):
    reader = FakeReader(result(item("Cortado", 4.57, confidence=0.3)))
    model = FakeModel([("set_price", {"item": "Cortado", "usd": 4.75})])
    brain = make_brain(tmp_path, model, reader)
    brain.handle_message(OWNER, "part of it", [b"photo"])
    reply = brain.handle_message(OWNER, "the cortado should be 4.75")[0]
    assert reply == 'Cortado is now $4.75.\nSo far: 1 price change. Reply "yes" to save, or tell me what to fix.'
    assert len(model.seen) == 1                                       # one model call; no second one to write text
    assert "confirm_update" in model.seen[0][1] and "set_scope" not in model.seen[0][1]
    assert "- Cortado: $4.57" in model.seen[0][0][0].content          # the draft is in the prompt
    assert brain.store.get_cafe("barbaras").current_version == 1


def test_owner_text_change_without_photo_then_yes(tmp_path):
    model = FakeModel([("set_price", {"item": "latte", "usd": 5.25})])
    brain = make_brain(tmp_path, model)
    assert model.seen == [] and "Latte is now $5.25" in brain.handle_message(OWNER, "latte is 5.25 now")[0]
    assert model.seen[0][1] == ["get_my_menu", "get_insights", "set_price", "rename_item", "add_item", "remove_item"]
    assert "version 2" in brain.handle_message(OWNER, "yes")[0]


def test_owner_question_answered_from_the_listed_menu_must_be_grounded(tmp_path):
    brain = make_brain(tmp_path, FakeModel("Your latte is $5.00."))
    assert brain.handle_message(OWNER, "what do I charge for a latte?") == ["Your latte is $5.00."]
    brain = make_brain(tmp_path / "second", FakeModel("Your latte is $6.00.", "It is $6.00."))
    assert brain.handle_message(OWNER, "what do I charge for a latte?") == [OWNER_HELP]


def test_owner_bad_tool_arguments_do_not_leak_errors(tmp_path):
    brain = make_brain(tmp_path, FakeModel([("set_price", {"item": "Latte"})]))
    assert brain.handle_message(OWNER, "change the latte") == [OWNER_HELP]


# ---------- insights ----------

def test_weekly_counts_and_summary(tmp_path):
    brain = make_brain(tmp_path)
    store = brain.store
    cafe = store.get_cafe("barbaras")
    store.add_event("search", data={"query": "Cortado", "shown": ["barbaras", "curiosity"]})
    store.add_event("search", data={"query": "cortado", "shown": ["barbaras"]})
    store.add_event("search", data={"query": "matcha", "shown": ["curiosity"]})
    store.add_event("pick", "barbaras")
    store.add_event("menu_view", "barbaras", data={"contains": "latte"})
    store.add_event("pick", "barbaras", created_at="2020-01-01T00:00:00+00:00")          # too old to count
    counts = weekly_counts(store, "barbaras")
    assert (counts["times_suggested"], counts["times_picked"], counts["menu_views"]) == (2, 1, 1)
    assert counts["top_searches"] == ["cortado"] and counts["top_items_looked_for"] == ["latte"]

    plain = owner_summary(store, cafe)
    assert "suggested 2 times, picked 1 times" in plain
    assert owner_summary(store, cafe, FakeModel("You were suggested 2 times and picked 1 time. Nice week!")) \
        == "You were suggested 2 times and picked 1 time. Nice week!"
    assert owner_summary(store, cafe, FakeModel("You were suggested 40 times!")) == plain    # invented number
    assert owner_summary(store, store.get_cafe("curiosity").model_copy(update={"cafe_id": "nobody"})) \
        .startswith("No activity")
