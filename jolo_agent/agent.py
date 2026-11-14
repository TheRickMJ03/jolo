"""The agent loop (LangGraph) and the model client.

    model -> tools -> model -> ... -> reply

Qwen3.5-9B is reached through the same OpenAI-compatible vLLM server as the
menu reader. Tool calls are asked for in one of two ways (agent.tool_mode):

    native  the OpenAI "tools" field. vLLM only supports it when started with
            --enable-auto-tool-choice and a --tool-call-parser.
    json    the tools are described in the prompt and the model answers with
            one JSON object. Works on any server.
    auto    native first; json from the moment the server refuses tools.
"""

import json
import logging
import operator
import re
import uuid
from dataclasses import dataclass, field
from typing import Annotated, Any, TypedDict

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages

log = logging.getLogger("jolo.agent")


class ModelDown(RuntimeError):
    """The model server can't be reached (VM stopped or SSH tunnel closed)."""


@dataclass
class ToolCall:
    name: str
    args: dict
    result: Any          # what the tool function returned
    text: str            # the same, as the text the model saw


@dataclass
class Turn:
    reply: str                                   # the model's final text ("" when it ended on tool calls)
    calls: list = field(default_factory=list)    # ToolCalls, in order
    messages: list = field(default_factory=list)


# ---------- JSON mode ----------

JSON_INSTRUCTIONS = """
You can use these tools:
{tools}

Answer with ONE JSON object and nothing else.
To use tools: {{"calls": [{{"tool": "<tool name>", "args": {{...}}}}]}}
To answer the user: {{"reply": "<your message>"}}
Use a tool whenever you need a fact. Never put a tool call and a reply in the same answer."""


def describe_tool(tool):
    """'- get_menu(cafe_id: string, contains?: string): what it does'"""
    schema = tool.get_input_schema().model_json_schema()
    required = set(schema.get("required", []))
    parts = []
    for name, spec in schema.get("properties", {}).items():
        kind = spec.get("type") or "/".join(option.get("type", "any") for option in spec.get("anyOf", [])
                                            if option.get("type") != "null") or "any"
        if spec.get("enum"):
            kind = " | ".join(json.dumps(value) for value in spec["enum"])
        parts.append(f"{name}{'' if name in required else '?'}: {kind}")
    return f"- {tool.name}({', '.join(parts)}): {tool.description}"


def parse_actions(text):
    """The model's text -> (tool calls, reply). Calls are [{"name", "args"}]; reply is str or None.

    Understands our JSON format, a bare {"tool": ...} object, and Qwen's own
    <tool_call>{"name": ..., "arguments": ...}</tool_call> blocks, which arrive
    as plain text when the server has no tool-call parser.
    """
    text = (text or "").strip()
    blocks = re.findall(r"<tool_call>\s*(\{.*?\})\s*</tool_call>", text, re.DOTALL)
    if blocks:
        calls = []
        for block in blocks:
            try:
                data = json.loads(block)
                calls.append({"name": data["name"], "args": data.get("arguments") or {}})
            except (ValueError, KeyError):
                continue
        if calls:
            return calls, None

    if "{" in text and "}" in text:
        try:
            data = json.loads(text[text.index("{"):text.rindex("}") + 1])
        except ValueError:
            data = None
        if isinstance(data, dict):
            actions = data.get("calls") if isinstance(data.get("calls"), list) else ([data] if "tool" in data else [])
            calls = [{"name": action["tool"], "args": action.get("args") or {}}
                     for action in actions if isinstance(action, dict) and action.get("tool")]
            if calls:
                return calls, None
            if isinstance(data.get("reply"), str):
                return [], data["reply"].strip()
    return [], text


def _as_ai_message(calls, reply):
    return AIMessage(content=reply or "", tool_calls=[
        {"name": call["name"], "args": call["args"], "id": f"call_{uuid.uuid4().hex[:12]}", "type": "tool_call"}
        for call in calls])


def to_json_mode(messages, tools):
    """Rewrite a conversation so a server without tool support can follow it:
    tool calls become JSON written by the assistant, tool results become user messages."""
    out = []
    for message in messages:
        if isinstance(message, SystemMessage):
            listing = "\n".join(describe_tool(tool) for tool in tools)
            out.append(SystemMessage(message.content + ("\n" + JSON_INSTRUCTIONS.format(tools=listing) if tools else "")))
        elif isinstance(message, AIMessage):
            if message.tool_calls:
                content = json.dumps({"calls": [{"tool": call["name"], "args": call["args"]}
                                                for call in message.tool_calls]}, ensure_ascii=False)
            else:
                content = json.dumps({"reply": message.content}, ensure_ascii=False) if tools else message.content
            out.append(AIMessage(content))
        elif isinstance(message, ToolMessage):
            line = f"Result of {message.name}: {message.content}"
            if out and isinstance(out[-1], HumanMessage) and out[-1].content.startswith("Result of "):
                out[-1] = HumanMessage(out[-1].content + "\n" + line)     # keep user/assistant turns alternating
            else:
                out.append(HumanMessage(line))
        else:
            out.append(message)
    return out


# ---------- the model client ----------

class ChatModel:
    """Qwen3.5-9B behind an OpenAI-compatible endpoint. invoke(messages, tools) -> AIMessage."""

    def __init__(self, config):
        self.settings = config["agent"]
        self.endpoint = self.settings["endpoint"] or config["endpoint"]
        self.mode = self.settings["tool_mode"]
        self._client = None

    def _chat(self):
        if self._client is None:
            from langchain_openai import ChatOpenAI
            self._client = ChatOpenAI(base_url=self.endpoint, api_key="not-needed", model=self.settings["model"],
                                      temperature=self.settings["temperature"],
                                      max_tokens=self.settings["max_tokens"],
                                      timeout=self.settings["timeout_seconds"], max_retries=1)
        return self._client

    def _send(self, messages, tools=None):
        import openai
        client = self._chat().bind_tools(tools) if tools else self._chat()
        try:
            return client.invoke(messages)
        except (openai.APIConnectionError, openai.APITimeoutError, openai.InternalServerError) as error:
            raise ModelDown(f"Could not reach {self.endpoint}: {error}") from error

    def invoke(self, messages, tools=()):
        import openai
        tools = list(tools)
        if tools and self.mode in ("native", "auto"):
            try:
                reply = self._send(messages, tools)
            except openai.BadRequestError as error:
                if self.mode == "native":
                    raise
                log.warning("The server refused tools (%s). Using JSON actions from now on.", str(error)[:200])
                self.mode = "json"
            else:
                if not reply.tool_calls and "<tool_call>" in (reply.content or ""):
                    return _as_ai_message(*parse_actions(reply.content))     # no parser on the server
                return reply
        if not tools:
            return self._send(to_json_mode(messages, []) if self.mode == "json" else messages)
        reply = self._send(to_json_mode(messages, tools))
        return _as_ai_message(*parse_actions(reply.content))


# ---------- the loop ----------

class _State(TypedDict):
    messages: Annotated[list, add_messages]
    calls: Annotated[list, operator.add]
    rounds: int


def _text(result):
    return result if isinstance(result, str) else json.dumps(result, ensure_ascii=False, default=str)


def run_turn(model, tools, messages, max_rounds=5, stop_after_tools=False):
    """Run one user message through the loop. Returns a Turn.

    model: has invoke(messages, tools) -> AIMessage (ChatModel, or a fake in tests).
    stop_after_tools: end right after the first tools ran, without asking the
        model to write a reply. For the owner flow, where the tools' own text is the reply.
    """
    by_name = {tool.name: tool for tool in tools}

    def call_model(state):
        return {"messages": [model.invoke(state["messages"], tools)], "rounds": state["rounds"] + 1}

    def call_tools(state):
        new_messages, calls = [], []
        for call in state["messages"][-1].tool_calls:
            tool = by_name.get(call["name"])
            if tool is None:
                result = {"error": f"There is no tool named {call['name']}. Tools: {', '.join(by_name)}"}
            else:
                try:
                    result = tool.invoke(call["args"])
                except Exception as error:      # bad arguments included: the model can try again
                    log.warning("Tool %s%s failed: %s", call["name"], call["args"], error)
                    result = {"error": str(error)[:300]}
            calls.append(ToolCall(call["name"], call["args"], result, _text(result)))
            new_messages.append(ToolMessage(content=calls[-1].text, tool_call_id=call["id"], name=call["name"]))
        return {"messages": new_messages, "calls": calls}

    def after_model(state):
        wants_tools = bool(state["messages"][-1].tool_calls)
        return "tools" if wants_tools and state["rounds"] <= max_rounds else END

    graph = StateGraph(_State)
    graph.add_node("model", call_model)
    graph.add_node("tools", call_tools)
    graph.add_edge(START, "model")
    graph.add_conditional_edges("model", after_model, {"tools": "tools", END: END})
    graph.add_edge("tools", END if stop_after_tools else "model")
    state = graph.compile().invoke({"messages": list(messages), "calls": [], "rounds": 0},
                                   {"recursion_limit": 2 * max_rounds + 6})

    last = state["messages"][-1]
    final = isinstance(last, AIMessage) and not last.tool_calls and isinstance(last.content, str)
    reply = last.content.strip() if final else ""
    return Turn(reply=reply, calls=state["calls"], messages=state["messages"])
