"""extract_menu(): runs the stages in order.

    intake -> preprocess -> crop -> read -> validate -> confidence (-> compare)

This is a pure function for the agent to call. It never writes to a database
and never decides what a result means.
"""

import time
from pathlib import Path

from menu_reader.compare import compare_menus
from menu_reader.confidence import score_items
from menu_reader.config import load_config
from menu_reader.crop import crop_menu
from menu_reader.intake import load_image
from menu_reader.model_client import ModelError
from menu_reader.preprocess import preprocess
from menu_reader.readers import READERS
from menu_reader.schema import MenuResult
from menu_reader.validate import build_items, parse_json_reply, parse_lines_reply


def prepare_image(image_path_or_bytes, config):
    """Stages 1 to 3: intake, preprocess, crop.

    Returns (image, photo_id, reason, timings). image is None when the photo
    can't be used; reason then says why (e.g. "blurry").
    """
    timings = {}
    photo_id = None
    if not isinstance(image_path_or_bytes, (bytes, bytearray)):
        photo_id = Path(image_path_or_bytes).stem

    start = time.perf_counter()
    intake = load_image(image_path_or_bytes,
                        max_side_px=config["intake"]["max_side_px"],
                        blur_threshold=config["intake"]["blur_threshold"])
    timings["intake"] = time.perf_counter() - start
    if not intake.readable:
        return None, photo_id, intake.reason, timings

    start = time.perf_counter()
    image, _info = preprocess(intake.image, config["preprocess"])
    timings["preprocess"] = time.perf_counter() - start

    start = time.perf_counter()
    image, _box = crop_menu(image, config, photo_id=photo_id)
    timings["crop"] = time.perf_counter() - start
    return image, photo_id, None, timings


def extract_menu(image_path_or_bytes, current_menu=None, config=None):
    """Photo of a menu in, MenuResult out.

    config: a dict from load_config(), or None for the default profile.
    current_menu: the café's menu so far (a MenuResult, a dict with "items", or a
        list of items). When given, "changes" is filled in.
    """
    config = config or load_config()

    image, photo_id, reason, timings = prepare_image(image_path_or_bytes, config)
    if image is None:
        return MenuResult(readable=False, reason=reason, timings=timings)

    # 4. Read
    read = READERS[config["reader"]["name"]]
    try:
        reply = read(image, config, photo_id)
    except ModelError as error:
        return MenuResult(readable=False, reason=f"model_error: {error}", timings=timings)
    timings["read"] = reply["seconds"]

    # 5. Validate
    start = time.perf_counter()
    cut_off = reply.get("finish_reason") == "length"
    if reply.get("format") == "lines":
        # A cut-off list would parse fine but miss the end of the menu: don't trust it.
        parsed = None if cut_off else parse_lines_reply(reply["text"])
    else:
        parsed = parse_json_reply(reply["text"])
    if parsed is None:
        timings["validate"] = time.perf_counter() - start
        reason = "model_output_cut_off" if cut_off else "model_output_not_json"
        return MenuResult(readable=False, reason=reason, timings=timings)
    items = build_items(parsed)
    hours = parsed.get("hours")
    timings["validate"] = time.perf_counter() - start

    # Confidence: does a second, independent read (PP-OCR on the CPU) back each item?
    start = time.perf_counter()
    ocr_lines = None
    if config.get("confidence", {}).get("ppocr_check"):
        from menu_reader.ppocr import read_text   # loads Paddle, so only when switched on
        ocr_lines = [line["text"] for line in read_text(image, config["ppocr"])]
    confidence = score_items(items, ocr_lines)
    timings["confidence"] = time.perf_counter() - start

    result = MenuResult(
        readable=True,
        confidence=confidence,
        hours=hours.strip() if isinstance(hours, str) and hours.strip() else None,
        items=items,
        timings=timings,
    )

    # 6. Compare, only when the caller gives the café's current menu.
    if current_menu is not None:
        start = time.perf_counter()
        result.changes = compare_menus(current_menu, items)
        timings["compare"] = time.perf_counter() - start
    return result
