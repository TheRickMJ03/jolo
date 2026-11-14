"""The brain: one entry point for every incoming message.

    handle_message(phone, text, photos) -> the replies to send now

Replies that only exist later (a menu read takes 15 to 100 seconds) go to the
outbox, which either POSTs them to Isaiah's callback URL or holds them for
GET /outbox.

Routing is done in code, from who is texting:
    owner + photo   -> the menu-update flow starts a read
    owner + text    -> plain answers ("yes") directly; anything else through
                       the model, which only picks a tool
    customer + text -> the model with the search tools, then the grounding check
"""

import logging
import threading
from collections import defaultdict, deque

import requests
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

from menu_reader.config import load_config
from jolo_agent import messages
from jolo_agent.agent import ChatModel, ModelDown, run_turn
from jolo_agent.flow import MenuUpdateFlow
from jolo_agent.grounding import ungrounded_facts
from jolo_agent.intents import quick_intent
from jolo_agent.menu_ops import format_prices
from jolo_agent.store.models import hash_handle
from jolo_agent.tools import EDIT_TOOLS, Context, customer_tools, owner_tools, template_reply

log = logging.getLogger("jolo.brain")

CUSTOMER_PROMPT = """You are JOLO, a friendly guide to local cafés, texting with a customer.

Rules:
- Every fact about a café (items, prices, opening hours, distance, address) must come from a tool result in this turn. Never answer café facts from memory. If the tools don't give you a fact, say you don't know it.
- To recommend cafés, call search_cafes first. Suggest 2 or 3 cafés, each with one short reason taken from the tool result.
- Copy prices, times and distances exactly as the tools give them. Never calculate or round.
- If the customer says where they are, pass it as "near". If a tool says the place is unknown, ask for a landmark.
- When the customer picks a café or says they are going, call record_pick.
- Plain text only, no markdown, at most 5 short lines."""

OWNER_PROMPT = """You are JOLO, helping the owner of {cafe} keep the café's menu up to date by text message.

Your job is to work out what the owner wants and call the matching tool. The tools write the answers.
- Call one tool for each thing the owner asks for. Use item names as they are listed below.
- Never call confirm_update unless the owner clearly says the update is correct or tells you to save it.
- A question you can answer from the list below: answer in one or two plain sentences, with prices exactly as listed.
- If you are not sure what the owner means, ask one short question. Plain text, no markdown.

{state}

{items}"""

REGENERATE = ("Your reply stated {facts}, which is not in the tool results. Write the reply again using only "
              "facts from the tool results above. If a fact is missing, say you don't know it.")
NO_GROUNDED_ANSWER = "I couldn't find a reliable answer to that. Could you ask it another way?"
OWNER_HELP = ("I didn't catch that. You can send a photo of your menu, tell me a change "
              '(like "the cortado is $4.75 now"), or ask to see your menu.')
ERROR = "Something went wrong on my side. Try again in a minute."

STATES = {
    None: "No menu update is open. The owner can send a photo, or describe a change in words.",
    "reading": "A menu photo is being read right now.",
    "awaiting_scope": "A photo was read. The owner has not said yet whether it shows the full menu or part of it.",
    "awaiting_confirmation": "A menu update is waiting for the owner's confirmation.",
}


class Outbox:
    """Messages that are ready after the request that caused them has returned."""

    def __init__(self, callback_url=None):
        self.callback_url = callback_url
        self._phones = {}                    # phone hash -> raw number, in memory only
        self._queue = defaultdict(list)      # phone hash -> texts
        self._lock = threading.Lock()

    def register(self, phone_hash, phone):
        self._phones[phone_hash] = phone

    def push(self, phone_hash, text):
        phone = self._phones.get(phone_hash)
        if self.callback_url and phone:
            try:
                requests.post(self.callback_url, json={"phone": phone, "text": text}, timeout=10).raise_for_status()
                return
            except requests.RequestException as error:
                log.warning("Callback to %s failed (%s). The message waits in the outbox.", self.callback_url, error)
        with self._lock:
            self._queue[phone_hash].append(text)

    def drain(self, phone):
        """The waiting messages for this phone number; they are removed."""
        with self._lock:
            return self._queue.pop(hash_handle(phone), [])


def _unique(texts):
    return list(dict.fromkeys(text for text in texts if text))


class Brain:
    def __init__(self, config, store, model, search, flow=None, outbox=None, notes=()):
        self.config = config
        self.settings = config["agent"]
        self.store = store
        self.model = model
        self.search = search
        self.outbox = outbox or Outbox(self.settings["api"]["callback_url"])
        self.flow = flow or MenuUpdateFlow(store, config, send=self.outbox.push, on_saved=self.reindex)
        self.notes = list(notes)
        self._history = defaultdict(lambda: deque(maxlen=2 * self.settings["history_turns"]))
        self.last = {}      # what happened in the latest message, for the evaluation scripts

    # ---------- entry point ----------

    def handle_message(self, phone, text="", photos=()):
        """One incoming message. photos: the original image files' bytes, untouched."""
        phone_hash = hash_handle(phone)
        self.outbox.register(phone_hash, phone)
        text = (text or "").strip()
        self.last = {"calls": [], "regenerated": False, "fallback": False}
        try:
            with self.flow.lock(phone_hash):
                cafe = self.store.find_cafe_by_owner(phone_hash)
                if photos:
                    return self._photos(phone_hash, cafe, photos, text)
                if not text:
                    return [messages.EMPTY_MESSAGE]
                replies = self._owner_turn(phone_hash, cafe, text) if cafe else self._customer_turn(phone_hash, text)
                history = self._history[phone_hash]
                history.append(HumanMessage(text))
                history.append(AIMessage("\n".join(replies)))
                return replies
        except ModelDown as error:
            log.warning("%s", error)
            return [messages.MODEL_DOWN]
        except Exception:
            log.exception("Could not handle a message")
            return [ERROR]

    def _photos(self, phone_hash, cafe, photos, text):
        if cafe is None:
            user = self.store.get_user(phone_hash)
            return [messages.NOT_AN_OWNER if user and user.role == "owner" else messages.PHOTO_FROM_CUSTOMER]
        replies = []
        for photo in photos:
            replies += self.flow.start_read(phone_hash, photo)
        # "Here's my full menu" sent with the photo already answers the scope question.
        intent = quick_intent(text, self.store.get_draft(phone_hash))
        if intent and intent[0] == "scope":
            replies = [reply for reply in replies if reply != messages.ASK_SCOPE]
            replies.append(self.flow.set_scope(phone_hash, intent[1]))
        return _unique(replies)

    # ---------- owner ----------

    def _owner_prompt(self, cafe, draft):
        version = self.store.get_current_menu(cafe.cafe_id)
        stored = version.items if version else []
        if draft and draft.items:
            listed = "Items in the update:\n" + "\n".join(f"- {item.item}: {format_prices(item)}"
                                                          for item in draft.items[:150])
            if stored:
                listed += "\n\nAlso on the stored menu: " + ", ".join(item.item for item in stored[:150])
        elif stored:
            listed = "The stored menu:\n" + "\n".join(f"- {item.item}: {format_prices(item)}" for item in stored[:150])
        else:
            listed = "The café has no menu on JOLO yet."
        return OWNER_PROMPT.format(cafe=cafe.name, state=STATES[draft.state if draft else None], items=listed)

    def _owner_turn(self, phone_hash, cafe, text):
        draft = self.store.get_draft(phone_hash)
        intent = quick_intent(text, draft)
        if intent:
            kind, value = intent
            if kind == "confirm":
                return [self.flow.confirm(phone_hash)]
            if kind == "cancel":
                return [self.flow.cancel(phone_hash)]
            if kind == "more":
                return [self.flow.show_more(phone_hash)]
            return [self.flow.set_scope(phone_hash, value)]

        context = Context(self.store, self.flow, self.search, self.config, phone_hash, cafe, self.model)
        system = self._owner_prompt(cafe, draft)
        conversation = [SystemMessage(system), *self._history[phone_hash], HumanMessage(text)]
        # One model call to choose tools; the tools' own text is the reply.
        turn = run_turn(self.model, owner_tools(context, draft), conversation, max_rounds=1, stop_after_tools=True)
        self.last["calls"] = [(call.name, call.args) for call in turn.calls]
        if turn.calls:
            replies = [call.text if isinstance(call.result, str) else OWNER_HELP for call in turn.calls]
            if any(call.name in EDIT_TOOLS for call in turn.calls):
                replies.append(self.flow.status(phone_hash))
            return ["\n".join(_unique(replies))]
        reply = self._grounded(turn, [system, text], owner_tools(context, draft))
        return [reply or self.flow.status(phone_hash) or OWNER_HELP]

    def apply_correction(self, phone, text):
        """The owner's fix to an open proposal, for the iMessage bridge (POST /v1/turn "correction").

        Applies the fix to the draft and returns the texts worth saying (what went
        wrong, or a question); [] when every edit worked. Only the edit tools are
        offered, so a correction can never save or cancel the update: that is the
        bridge's "confirm" event.
        """
        phone_hash = hash_handle(phone)
        self.last = {"calls": [], "regenerated": False, "fallback": False}
        try:
            with self.flow.lock(phone_hash):
                cafe = self.store.find_cafe_by_owner(phone_hash)
                draft = self.store.get_draft(phone_hash)
                if cafe is None or draft is None:
                    return [messages.NOTHING_TO_CONFIRM]
                context = Context(self.store, self.flow, self.search, self.config, phone_hash, cafe, self.model)
                tools = [tool for tool in owner_tools(context, draft) if tool.name in EDIT_TOOLS]
                system = self._owner_prompt(cafe, draft)
                before = len(draft.ops)
                turn = run_turn(self.model, tools, [SystemMessage(system), HumanMessage(text)],
                                max_rounds=1, stop_after_tools=True)
                self.last["calls"] = [(call.name, call.args) for call in turn.calls]
                if not turn.calls:
                    return [self._grounded(turn, [system, text], tools) or OWNER_HELP]
                applied = len(self.store.get_draft(phone_hash).ops) - before
                if applied == len(turn.calls):
                    return []
                return _unique(call.text if isinstance(call.result, str) else OWNER_HELP for call in turn.calls)
        except ModelDown as error:
            log.warning("%s", error)
            return [messages.MODEL_DOWN]

    # ---------- customer ----------

    def _customer_turn(self, phone_hash, text):
        context = Context(self.store, self.flow, self.search, self.config, phone_hash)
        tools = customer_tools(context)
        conversation = [SystemMessage(CUSTOMER_PROMPT), *self._history[phone_hash], HumanMessage(text)]
        turn = run_turn(self.model, tools, conversation, max_rounds=self.settings["max_tool_rounds"])
        self.last["calls"] = [(call.name, call.args) for call in turn.calls]
        evidence = [text] + [call.text for call in turn.calls]
        return [self._grounded(turn, evidence, tools) or template_reply(turn.calls) or NO_GROUNDED_ANSWER]

    # ---------- grounding ----------

    def _grounded(self, turn, evidence, tools):
        """The turn's reply if every price, time and distance in it is in the
        evidence; otherwise one more try with the problem named; otherwise None."""
        reply = turn.reply
        problems = ungrounded_facts(reply, evidence) if reply else ["no reply"]
        if not problems:
            return reply
        log.info("Ungrounded reply (%s); asking again.", ", ".join(problems))
        self.last["regenerated"] = True
        retry = list(turn.messages)
        if not reply:
            retry.append(HumanMessage("Now write the reply to the user, using only the tool results above."))
        else:
            retry.append(HumanMessage(REGENERATE.format(facts=", ".join(problems))))
        second = self.model.invoke(retry, tools)
        text = second.content.strip() if isinstance(second.content, str) and not second.tool_calls else ""
        if text and not ungrounded_facts(text, evidence):
            return text
        log.info("Second reply was not grounded either; using the tool results directly.")
        self.last["fallback"] = True
        return None

    # ---------- upkeep ----------

    def reindex(self, cafe_id):
        """Bring one café's search documents up to date after its menu changed."""
        from jolo_agent.search.index import cafe_docs
        cafe = self.store.get_cafe(cafe_id)
        version = self.store.get_current_menu(cafe_id)
        self.search.index.reindex_cafe(cafe_id, cafe_docs(cafe, version.items if version else []))

    def warm(self):
        """Load the retrieval models now, so the first customer doesn't wait for them."""
        try:
            self.search.search("coffee", record=False)
        except Exception:
            log.exception("Could not warm up search")

    def health(self):
        endpoint = self.settings["endpoint"] or self.config["endpoint"]
        try:
            model_up = requests.get(endpoint.rstrip("/") + "/models", timeout=3).status_code == 200
        except requests.RequestException:
            model_up = False
        index = self.search.index
        return {
            "model_server": model_up,       # false: owners get "I can't read menus right now"
            "tool_mode": getattr(self.model, "mode", None),
            "store": self.settings["store"]["backend"],
            "cafes": len(self.store.list_cafes()),
            "search": {"documents": len(index.rows), "vectors": index.has_vectors,
                       "reranker": self.search.reranker is not None},
            "notes": self.notes,
        }


def build_brain(config=None):
    """The brain as configured in config.yaml: real store, real model, real search."""
    from jolo_agent.search import open_search
    from jolo_agent.store import open_store
    config = config or load_config()
    store = open_store(config)
    search, notes = open_search(store, config)
    return Brain(config, store, ChatModel(config), search, notes=notes)
