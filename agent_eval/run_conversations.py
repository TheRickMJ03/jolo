"""Run the scripted conversations (agent_eval/conversations.yaml) against the agent and score them.

Usage (from the repo root, venv active):
    python agent_eval/run_conversations.py            # the real model: VM server running, tunnel open
    python agent_eval/run_conversations.py --oracle   # no server: a stand-in model that makes the expected calls
    python agent_eval/run_conversations.py --only o02_fix_a_price -v

--oracle checks the script itself and everything around the model (tools, flow,
store, search): if it doesn't score 100%, a conversation or the code is wrong.
It says nothing about how well Qwen does.

Scores (docs/model-plan.md asks for these four):
    tool-call accuracy   turns where the expected tools were called with the expected
                         arguments, and no forbidden tool was called
    task success         conversations where every turn passed and the store ended up right
    groundedness         model-written replies that passed the grounding check first time
    median latency       seconds per turn (the pretended menu read takes no time)

Menu photos are not read by the real reader here; see conversations.yaml.
Results are saved to agent_eval/results/conversations.json.
"""

import argparse
import json
import shutil
import statistics
import sys
import tempfile
import time
from pathlib import Path

import requests
import yaml
from langchain_core.messages import AIMessage

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))
sys.path.insert(0, str(REPO / "scripts"))

from menu_reader.compare import _key, _size_key                           # noqa: E402
from menu_reader.config import load_config                                # noqa: E402
from menu_reader.schema import MenuItem, MenuResult, Price                # noqa: E402
from jolo_agent.agent import ChatModel                                    # noqa: E402
from jolo_agent.brain import Brain, Outbox                                # noqa: E402
from jolo_agent.flow import MenuUpdateFlow                                # noqa: E402
from jolo_agent.search import CafeSearch, SearchIndex, load_models        # noqa: E402
from jolo_agent.store import MemoryStore, hash_phone                      # noqa: E402
from seed_store import seed                                               # noqa: E402

OWNER = "+16095550100"
CUSTOMER = "+16095550199"


class Inline:
    def submit(self, function, *args):
        function(*args)


class Counting:
    """Wraps the model to count calls, so we know which turns the model handled."""

    def __init__(self, model):
        self.model = model
        self.calls = 0

    @property
    def mode(self):
        return getattr(self.model, "mode", None)

    def invoke(self, messages, tools=()):
        self.calls += 1
        return self.model.invoke(messages, tools)


class Oracle:
    """Makes exactly the calls the turn expects, then says "OK."."""
    mode = "oracle"

    def __init__(self):
        self.plan = []

    def invoke(self, messages, tools=()):
        if not self.plan:
            return AIMessage("OK.")
        plan, self.plan = self.plan, []
        return AIMessage("", tool_calls=[{"name": name, "args": args, "id": f"call_{number}", "type": "tool_call"}
                                         for number, (name, args) in enumerate(plan)])


def expected_calls(turn):
    """The turn's "tools" as [(name, args)]. Accepts {name: args} or a list of them."""
    tools = turn.get("tools") or []
    if isinstance(tools, dict):
        tools = [{name: args} for name, args in tools.items()]
    return [(name, args or {}) for entry in tools for name, args in entry.items()]


def photo_result(entries):
    """The MenuResult the pretended reader returns: entries with the same name become one item's sizes."""
    items = {}
    for entry in entries:
        item = items.setdefault(entry["item"], MenuItem(item=entry["item"], category=entry.get("category", "drink"),
                                                        confidence=entry.get("confidence", 0.8)))
        if entry.get("usd") is not None:
            item.prices.append(Price(size=entry.get("size"), usd=entry["usd"]))
    return MenuResult(readable=True, items=list(items.values()), confidence=0.8)


def args_match(expected, actual):
    for name, value in expected.items():
        got = actual.get(name)
        if isinstance(value, bool) or isinstance(value, (int, float)):
            if isinstance(got, bool) != isinstance(value, bool) or got is None or abs(float(got) - float(value)) > 0.005:
                return False
        elif _key(str(value)) not in _key(str(got or "")):
            return False
    return True


def check_turn(turn, calls, reply, oracle):
    """Returns (tool problems, reply problems) as lists of text."""
    called = [name for name, _args in calls]
    tool_problems, reply_problems = [], []
    for name, args in expected_calls(turn):
        if not any(call_name == name and args_match(args, call_args) for call_name, call_args in calls):
            tool_problems.append(f"expected {name}({args}), got {calls or 'no tool call'}")
    if turn.get("any_tool") and not set(turn["any_tool"]) & set(called):
        tool_problems.append(f"expected one of {turn['any_tool']}, got {called or 'no tool call'}")
    if turn.get("no_tools") and called:
        tool_problems.append(f"expected no tool call, got {called}")
    for name in turn.get("forbid", []):
        if name in called:
            tool_problems.append(f"{name} must not be called here")
    if not oracle:          # the oracle doesn't write replies
        lowered = reply.lower()
        for text in turn.get("reply_has", []):
            if text.lower() not in lowered:
                reply_problems.append(f'reply lacks "{text}"')
        if turn.get("reply_any") and not any(text.lower() in lowered for text in turn["reply_any"]):
            reply_problems.append(f"reply has none of {turn['reply_any']}")
        for text in turn.get("reply_lacks", []):
            if text.lower() in lowered:
                reply_problems.append(f'reply must not contain "{text}"')
    return tool_problems, reply_problems


def check_store(store, spec):
    problems = []
    cafe = store.get_cafe("barbaras")
    menu = {_key(item.item): item for item in store.get_current_menu("barbaras").items}
    if "version" in spec and cafe.current_version != spec["version"]:
        problems.append(f"menu version is {cafe.current_version}, expected {spec['version']}")
    for cafe_id, version in (spec.get("versions") or {}).items():       # other cafés must not have been touched
        other = store.get_cafe(cafe_id)
        if other is None or other.current_version != version:
            problems.append(f"{cafe_id} is at version {other.current_version if other else None}, expected {version}")
    for name, usd in (spec.get("prices") or {}).items():
        item = menu.get(_key(name))
        if item is None or not any(abs(price.usd - usd) < 0.005 for price in item.prices):
            problems.append(f"{name} should cost {usd}, menu has {[p.usd for p in item.prices] if item else 'no such item'}")
    for name in spec.get("has_items", []):
        if _key(name) not in menu:
            problems.append(f"{name} should be on the menu")
    for name in spec.get("lacks_items", []):
        if _key(name) in menu:
            problems.append(f"{name} should not be on the menu")
    for name, sizes in (spec.get("sizes") or {}).items():
        item = menu.get(_key(name))
        got = sorted(_size_key(price.size) for price in item.prices) if item else None
        if got != sorted(_size_key(size) for size in sizes):
            problems.append(f"{name} should have sizes {sizes}, has {got}")
    if "source" in spec and store.get_current_menu("barbaras").source != spec["source"]:
        problems.append(f"menu source is {store.get_current_menu('barbaras').source}, expected {spec['source']}")
    if "corrections" in spec and len(store.list_corrections("barbaras")) != spec["corrections"]:
        problems.append(f"{len(store.list_corrections('barbaras'))} corrections stored, expected {spec['corrections']}")
    if "picks" in spec and [event.cafe_id for event in store.list_events("pick")] != spec["picks"]:
        problems.append(f"picks are {[event.cafe_id for event in store.list_events('pick')]}, expected {spec['picks']}")
    if "draft" in spec and (store.get_draft(hash_phone(OWNER)) is not None) != spec["draft"]:
        problems.append("a draft is still open" if not spec["draft"] else "no draft is open")
    return problems


def run_conversation(conversation, config, model, embedder, reranker, index_source, oracle, verbose):
    store = MemoryStore()
    seed(store, [(OWNER, "barbaras")])
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as folder:
        # A private copy of the search index: saving a menu re-indexes, and the real index must not change.
        shutil.copytree(index_source, Path(folder) / "index")
        search = CafeSearch(store, SearchIndex(Path(folder) / "index", embedder), config, reranker)
        photos = []
        outbox = Outbox()
        flow = MenuUpdateFlow(store, config, reader=lambda photo: photos.pop(0), send=outbox.push, executor=Inline())
        brain = Brain(config, store, model, search, flow=flow, outbox=outbox)
        flow.on_saved = brain.reindex
        phone = OWNER if conversation["role"] == "owner" else CUSTOMER

        turns, problems = [], []
        for number, turn in enumerate(conversation["turns"], 1):
            if oracle:
                model.model.plan = expected_calls(turn) or [(name, {}) for name in turn.get("any_tool", [])[:1]]
            images = []
            if turn.get("photo"):
                photos.append(photo_result(turn["photo"]))
                images = [b"pretend photo"]
            before = model.calls
            start = time.perf_counter()
            replies = brain.handle_message(phone, turn["user"], images)
            seconds = time.perf_counter() - start
            reply = "\n".join(replies + outbox.drain(phone))
            tool_problems, reply_problems = check_turn(turn, brain.last.get("calls", []), reply, oracle)
            has_tool_check = bool(expected_calls(turn) or turn.get("any_tool") or turn.get("no_tools") or turn.get("forbid"))
            turns.append({"user": turn["user"], "reply": reply, "calls": brain.last.get("calls", []),
                          "seconds": round(seconds, 2), "model_calls": model.calls - before,
                          "tool_check": has_tool_check, "tool_ok": not tool_problems,
                          "grounded_first_time": not brain.last.get("regenerated"),
                          "fallback": bool(brain.last.get("fallback"))})
            problems += [f"turn {number}: {problem}" for problem in tool_problems + reply_problems]
            if verbose:
                print(f"    > {turn['user'] or '(photo)'}\n    < {reply}\n      calls: {brain.last.get('calls', [])}")
        problems += [f"store: {problem}" for problem in check_store(store, conversation.get("store") or {})]
        del search, brain          # let go of the index files before the folder is removed
    return {"id": conversation["id"], "role": conversation["role"], "success": not problems,
            "problems": problems, "turns": turns}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--oracle", action="store_true", help="use a stand-in model that makes the expected calls")
    parser.add_argument("--only", help="run one conversation, by id")
    parser.add_argument("-v", "--verbose", action="store_true", help="print every message")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    config = load_config()
    conversations = yaml.safe_load((REPO / "agent_eval" / "conversations.yaml").read_text(encoding="utf-8"))["conversations"]
    if args.only:
        conversations = [c for c in conversations if c["id"] == args.only] or sys.exit(f"No conversation {args.only!r}")
    index_source = REPO / config["agent"]["search"]["index_dir"]
    if not index_source.exists():
        sys.exit("No search index. Run scripts/seed_store.py, then scripts/build_index.py.")

    if args.oracle:
        model = Counting(Oracle())
    else:
        endpoint = config["agent"]["endpoint"] or config["endpoint"]
        try:
            requests.get(endpoint.rstrip("/") + "/models", timeout=10)
        except requests.RequestException as error:
            sys.exit(f"The model server is not answering at {endpoint}.\n"
                     f"Start the VM server and the SSH tunnel, or use --oracle.\n({error})")
        model = Counting(ChatModel(config))
    embedder, reranker, _notes = load_models(config)

    results = []
    for conversation in conversations:
        outcome = run_conversation(conversation, config, model, embedder, reranker, index_source,
                                   args.oracle, args.verbose)
        results.append(outcome)
        print(f"{'ok  ' if outcome['success'] else 'FAIL'} {outcome['id']}")
        for problem in outcome["problems"]:
            print(f"       {problem}")

    turns = [turn for outcome in results for turn in outcome["turns"]]
    checked = [turn for turn in turns if turn["tool_check"]]
    written = [turn for turn in turns if turn["model_calls"] and not turn["calls"] or turn["model_calls"] > 1]
    summary = {
        "model": "oracle (stand-in)" if args.oracle else f"{config['agent']['model']} ({model.mode} tool calls)",
        "conversations": len(results),
        "task_success": round(sum(outcome["success"] for outcome in results) / len(results), 3),
        "tool_call_accuracy": round(sum(turn["tool_ok"] for turn in checked) / len(checked), 3) if checked else None,
        "groundedness": (round(sum(turn["grounded_first_time"] for turn in written) / len(written), 3)
                         if written and not args.oracle else None),
        "fallback_replies": sum(turn["fallback"] for turn in turns),
        "median_seconds_per_turn": round(statistics.median(turn["seconds"] for turn in turns), 2),
        "median_seconds_per_model_turn": (round(statistics.median(turn["seconds"] for turn in turns if turn["model_calls"]), 2)
                                          if any(turn["model_calls"] for turn in turns) else None),
    }
    print()
    for name, value in summary.items():
        print(f"{name:<32}{value}")
    if args.oracle:
        print("\nThis was the stand-in model: it checks the script and the code around the model, not Qwen.")

    out = REPO / "agent_eval" / "results" / ("conversations_oracle.json" if args.oracle else "conversations.json")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"summary": summary, "conversations": results}, indent=2, ensure_ascii=False, default=str),
                   encoding="utf-8")
    print(f"Saved to {out.relative_to(REPO)}")


if __name__ == "__main__":
    main()
