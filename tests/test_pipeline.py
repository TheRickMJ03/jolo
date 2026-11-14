"""Tests for the pipeline skeleton. The model is faked, so no server is needed."""

import io
import json

import pytest
from PIL import Image

from eval.run_eval import flatten_menu_result
from menu_reader import model_client, pipeline, readers
from menu_reader.config import load_config
from menu_reader.model_client import ModelError, image_to_data_uri
from menu_reader.readers import glm_ocr_schema_prompt
from menu_reader.schema import MenuResult
from menu_reader.validate import build_items, parse_json_reply, parse_lines_reply, parse_usd

import numpy as np

MODEL_JSON = {
    "hours": "7am - 3pm",
    "items": [
        {"section": "Espresso", "item": "Cortado", "category": "drink",
         "prices": [{"size": "8 oz", "usd": "$4.50"}],
         "add_ons": [{"name": "Oat milk", "usd": "0.75"}],
         "variants": ["Vanilla", ""], "tags": [""]},
        {"section": "", "item": "Croissant", "category": "pastry",
         "prices": [{"size": "", "usd": ""}], "add_ons": [{"name": "", "usd": ""}],
         "variants": [""], "tags": [""]},
        {"section": "", "item": "", "category": "", "prices": []},
    ],
}


def png_bytes():
    buffer = io.BytesIO()
    Image.new("RGB", (300, 200), "white").save(buffer, format="PNG")
    return buffer.getvalue()


def fake_reader(text, finish_reason="stop"):
    def read(image, config, photo_id=None):
        return {"text": text, "finish_reason": finish_reason, "seconds": 1.5}
    return {"glm_ocr_schema": read}


class FakeResponse:
    """Stands in for the HTTP reply of an OpenAI-compatible server."""
    status_code = 200
    text = ""

    def __init__(self, content):
        self.content = content

    def json(self):
        return {"choices": [{"message": {"content": self.content}, "finish_reason": "stop"}]}


# ---------- validate ----------

def test_parse_json_reply():
    assert parse_json_reply('{"items": []}') == {"items": []}
    assert parse_json_reply('```json\n{"items": []}\n```') == {"items": []}
    assert parse_json_reply("Here you go: {\"hours\": \"\"} Done.") == {"hours": ""}
    assert parse_json_reply("no json here") is None
    assert parse_json_reply('{"items": [') is None
    assert parse_json_reply("[1, 2]") is None


def test_parse_usd_never_guesses():
    assert parse_usd("$4.50") == 4.5
    assert parse_usd("4.5") == 4.5
    assert parse_usd(3) == 3.0
    assert parse_usd("") is None
    assert parse_usd(None) is None
    assert parse_usd("market price") is None
    assert parse_usd(0) is None          # models write 0 for "no price"
    assert parse_usd("0.00") is None


def test_build_items():
    items = build_items(MODEL_JSON)
    assert [item.item for item in items] == ["Cortado", "Croissant"]   # the nameless one is dropped

    cortado, croissant = items
    assert cortado.section == "Espresso"
    assert cortado.prices[0].size == "8 oz" and cortado.prices[0].usd == 4.5
    assert cortado.add_ons[0].name == "Oat milk" and cortado.add_ons[0].usd == 0.75
    assert cortado.variants == ["Vanilla"]
    assert cortado.tags == []

    assert croissant.prices == []        # empty price in, no price out: never invented
    assert croissant.add_ons == []
    assert croissant.category == "food"  # "pastry" is not allowed, so the fallback is used


def test_build_items_from_flat_rows():
    items = build_items({"items": [
        {"section": "Coffee", "item": "Latte", "size": "Sm", "price": "3.50"},
        {"section": "Coffee", "item": "Latte", "size": "Lg", "price": "$4.25"},
        {"section": "Coffee", "item": "Espresso", "size": "", "price": "2.5"},
        {"section": "Bowls", "item": "Açai", "size": "", "price": ""},
        {"section": "Smoothies", "item": "Açai", "size": "", "price": "7"},   # same name, other section
        {"section": "", "item": "", "size": "", "price": "9"},                # no name: dropped
    ]})
    assert [item.item for item in items] == ["Latte", "Espresso", "Açai", "Açai"]
    assert [(p.size, p.usd) for p in items[0].prices] == [("Sm", 3.5), ("Lg", 4.25)]
    assert [(p.size, p.usd) for p in items[1].prices] == [(None, 2.5)]
    assert items[2].prices == []
    assert items[3].prices[0].usd == 7.0


LINES_REPLY = """\
HOURS | 7am - 3pm
Coffee | Latte | SM 4.5; LG $5.25 | drink |
Coffee | Syrups | 0.75 | modifier | Vanilla; Caramel
Bakery | Soup of the Day | | food
 | Croissant | 3 | food |
Here is the menu you asked for.
 | | 3 | food |
Coffee | Americano | 4.5; 5.5 | drink |
Coffee | Cold Brew | 12 oz 4; 16 oz 5; refill | drink |
"""


def test_parse_lines_reply():
    parsed = parse_lines_reply(LINES_REPLY)
    assert parsed["hours"] == "7am - 3pm"
    items = build_items(parsed)
    assert [item.item for item in items] == ["Latte", "Syrups", "Soup of the Day", "Croissant",
                                             "Americano", "Cold Brew"]
    assert items[3].section is None and items[3].prices[0].usd == 3.0
    assert [(p.size, p.usd) for p in items[0].prices] == [("SM", 4.5), ("LG", 5.25)]   # labels as printed
    # Sizes the menu doesn't name get our labels; the prices stay as read.
    assert [(p.size, p.usd) for p in items[4].prices] == [("small", 4.5), ("large", 5.5)]
    # A piece with no number ("refill") is dropped, never given a price.
    assert [(p.size, p.usd) for p in items[5].prices] == [("12 oz", 4.0), ("16 oz", 5.0)]
    assert items[1].category == "modifier" and items[1].variants == ["Vanilla", "Caramel"]
    assert items[2].prices == []                      # no price shown, none invented
    assert parse_lines_reply("I cannot read this menu.") is None


def test_size_row_above_a_group_of_prices():
    items = build_items(parse_lines_reply(
        "SIZES | Small; Medium; Large; Extra Large\n"
        "Pizzas | Margherita | 12.99; 14.99; 18.99; 21.99 | food\n"
        "Pizzas | Calzone | 9 | food\n"
        "Pizzas | Garlic Knots | 5; 8 | food\n"       # two prices, four names: not a match
        "Drinks | Soda | 2; 3; 4; 5 | drink\n"        # another section: the size row is over
    ))
    assert [p.size for p in items[0].prices] == ["Small", "Medium", "Large", "Extra Large"]
    assert [p.usd for p in items[0].prices] == [12.99, 14.99, 18.99, 21.99]
    assert [(p.size, p.usd) for p in items[1].prices] == [(None, 9.0)]
    assert [p.size for p in items[2].prices] == ["small", "large"]
    # No size names for these four: one item, four prices, sizes left empty.
    assert [item.item for item in items] == ["Margherita", "Calzone", "Garlic Knots", "Soda"]
    assert [(p.size, p.usd) for p in items[3].prices] == [(None, 2.0), (None, 3.0), (None, 4.0), (None, 5.0)]

    # The model sometimes writes the size row after the items it belongs to.
    items = build_items(parse_lines_reply(
        "Pizzas | Margherita | 12.99; 14.99; 18.99; 21.99 | food\n"
        "SIZES | Small; Medium; Large; Extra Large\n"
        "Pizzas | Stuffed Crust | 2; 4 | modifier\n"
    ))
    assert [p.size for p in items[0].prices] == ["Small", "Medium", "Large", "Extra Large"]
    assert [p.size for p in items[1].prices] == ["small", "large"]


def test_extract_menu_with_the_lines_format(monkeypatch):
    def read(image, config, photo_id=None):
        return {"text": LINES_REPLY, "finish_reason": "stop", "seconds": 1.0, "format": "lines"}
    monkeypatch.setattr(pipeline, "READERS", {"glm_ocr_schema": read})
    result = pipeline.extract_menu(png_bytes(), config=load_config("laptop_cpu"))
    assert result.readable and result.hours == "7am - 3pm"
    assert len(result.items) == 6

    def read_cut_off(image, config, photo_id=None):
        return {"text": LINES_REPLY, "finish_reason": "length", "seconds": 1.0, "format": "lines"}
    monkeypatch.setattr(pipeline, "READERS", {"glm_ocr_schema": read_cut_off})
    result = pipeline.extract_menu(png_bytes(), config=load_config("laptop_cpu"))
    assert not result.readable and result.reason == "model_output_cut_off"


# ---------- model client and prompt ----------

def test_image_to_data_uri():
    uri = image_to_data_uri(np.zeros((10, 10, 3), dtype=np.uint8))
    assert uri.startswith("data:image/png;base64,")


def test_glm_ocr_prompt_is_instruction_plus_template():
    prompt = glm_ocr_schema_prompt()
    first_line, template = prompt.split("\n", 1)
    assert first_line.endswith(":")
    assert set(json.loads(template)) == {"hours", "items"}


# ---------- pipeline ----------

def test_extract_menu_end_to_end(monkeypatch):
    monkeypatch.setattr(pipeline, "READERS", fake_reader(json.dumps(MODEL_JSON)))
    result = pipeline.extract_menu(png_bytes(), config=load_config("laptop_cpu"))

    assert isinstance(result, MenuResult)
    assert result.readable and result.reason is None
    assert result.hours == "7am - 3pm"
    assert len(result.items) == 2
    assert set(result.timings) == {"intake", "preprocess", "crop", "read", "validate", "confidence"}
    assert result.confidence == 0.5 and result.items[0].confidence == 0.5   # unchecked: PP-OCR check is off

    # The JSON has exactly the fields the team builds against.
    as_json = result.model_dump()
    assert set(as_json) == {"readable", "reason", "confidence", "hours", "items", "changes", "timings"}
    assert set(as_json["items"][0]) == {"section", "item", "category", "prices", "add_ons",
                                        "variants", "tags", "confidence"}
    assert set(as_json["changes"]) == {"new_items", "price_changes", "missing_from_photo"}

    # And the eval harness can score it.
    assert flatten_menu_result(as_json) == [
        {"item": "Cortado", "size": "8 oz", "price": 4.5, "category": "drink"},
        {"item": "Oat milk", "size": "", "price": 0.75, "category": "modifier"},
        {"item": "Croissant", "size": "", "price": None, "category": "food"},
    ]


def test_unreadable_file():
    result = pipeline.extract_menu(b"not an image", config=load_config("laptop_cpu"))
    assert not result.readable
    assert result.reason == "unreadable_file"
    assert result.items == []


def test_model_reply_that_is_not_json(monkeypatch):
    monkeypatch.setattr(pipeline, "READERS", fake_reader("Sorry, I cannot read this."))
    result = pipeline.extract_menu(png_bytes(), config=load_config("laptop_cpu"))
    assert not result.readable
    assert result.reason == "model_output_not_json"


def test_model_reply_cut_off(monkeypatch):
    monkeypatch.setattr(pipeline, "READERS", fake_reader('{"items": [{"item": "Lat', finish_reason="length"))
    result = pipeline.extract_menu(png_bytes(), config=load_config("laptop_cpu"))
    assert not result.readable
    assert result.reason == "model_output_cut_off"


def test_model_server_down(monkeypatch):
    def read(image, config, photo_id=None):
        raise ModelError("connection refused")
    monkeypatch.setattr(pipeline, "READERS", {"glm_ocr_schema": read})
    result = pipeline.extract_menu(png_bytes(), config=load_config("laptop_cpu"))
    assert not result.readable
    assert result.reason.startswith("model_error")


def test_cache_avoids_a_second_model_call(monkeypatch, tmp_path):
    calls = []

    def fake_post(url, json, headers, timeout):
        calls.append(url)
        return FakeResponse('{"items": []}')

    monkeypatch.setattr(model_client.requests, "post", fake_post)
    monkeypatch.setattr(model_client, "REPO", tmp_path)
    config = load_config("laptop_cpu")
    config["cache"] = {"reads_dir": "reads"}
    image = np.zeros((10, 10, 3), dtype=np.uint8)

    first = model_client.ask_about_image(image, "Text Recognition:", config, "glm_ocr", 100, "photo_1")
    second = model_client.ask_about_image(image, "Text Recognition:", config, "glm_ocr", 100, "photo_1")
    assert len(calls) == 1
    assert calls[0] == "http://localhost:11434/v1/chat/completions"
    assert second == first                                   # same text and the saved model time

    # A different prompt is a different question, so the model is called again.
    model_client.ask_about_image(image, "Table Recognition:", config, "glm_ocr", 100, "photo_1")
    assert len(calls) == 2


def test_model_with_its_own_endpoint_and_key(monkeypatch):
    seen = {}

    def fake_post(url, json, headers, timeout):
        seen.update(url=url, model=json["model"], auth=headers["Authorization"])
        return FakeResponse("{}")

    monkeypatch.setattr(model_client.requests, "post", fake_post)
    monkeypatch.setenv("STRUCTURER_API_KEY", "secret-key")
    config = load_config("laptop_cpu")
    config["models"]["structurer"] = {"name": "some-model", "endpoint": "https://api.example.com/v1/",
                                      "api_key_env": "STRUCTURER_API_KEY"}
    model_client.ask_text("hello", config, "structurer", 100)
    assert seen == {"url": "https://api.example.com/v1/chat/completions", "model": "some-model",
                    "auth": "Bearer secret-key"}


def test_missing_structurer_is_a_clear_error():
    config = load_config("laptop_cpu")
    config["models"]["structurer"] = None
    with pytest.raises(ModelError, match="structurer"):
        model_client.ask_text("hello", config, "structurer", 100)


def test_two_step_reader_passes_the_transcript_to_the_structurer(monkeypatch):
    prompts = []

    def fake_image(image, prompt, config, model_key, max_tokens, cache_label=None):
        return {"text": "Latte 4.50", "finish_reason": "stop", "seconds": 2.0}

    def fake_text(prompt, config, model_key, max_tokens, cache_label=None):
        prompts.append((model_key, prompt))
        return {"text": '{"items": []}', "finish_reason": "stop", "seconds": 3.0}

    monkeypatch.setattr(readers, "ask_about_image", fake_image)
    monkeypatch.setattr(readers, "ask_text", fake_text)
    reply = readers.read_glm_ocr_then_structure(np.zeros((10, 10, 3), dtype=np.uint8),
                                                load_config("laptop_cpu"))
    assert prompts[0][0] == "structurer"
    assert prompts[0][1].endswith("Latte 4.50")
    assert reply["seconds"] == 5.0
    assert reply["transcript"] == "Latte 4.50"
