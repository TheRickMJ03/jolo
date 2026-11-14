"""Crop the photo down to the menu. Three modes, chosen in config.yaml (crop.mode):

    none          keep the whole photo
    ppocr_boxes   keep the rectangle around all the text PP-OCRv6 found
    sam3_cached   use a crop that SAM 3 computed earlier on the VM
"""

from pathlib import Path

import cv2

from menu_reader.config import REPO
from menu_reader.ppocr import read_text


def union_box(boxes, image_width, image_height, margin=0.03):
    """Smallest rectangle around all boxes, plus a margin, kept inside the image.

    boxes are (x1, y1, x2, y2). margin is a fraction of the image size.
    Returns (x1, y1, x2, y2), or None when there are no boxes.
    """
    if not boxes:
        return None
    pad_x = int(margin * image_width)
    pad_y = int(margin * image_height)
    x1 = max(0, min(box[0] for box in boxes) - pad_x)
    y1 = max(0, min(box[1] for box in boxes) - pad_y)
    x2 = min(image_width, max(box[2] for box in boxes) + pad_x)
    y2 = min(image_height, max(box[3] for box in boxes) + pad_y)
    return (x1, y1, x2, y2)


def crop_menu(image, config, photo_id=None, text_lines=None):
    """Returns (cropped_image, box). box is None when the whole photo is kept.

    text_lines: PP-OCR lines for this image if you already have them, so the
    OCR doesn't run twice.
    """
    settings = config["crop"]
    mode = settings["mode"]
    height, width = image.shape[:2]

    if mode == "none":
        return image, None

    if mode == "ppocr_boxes":
        if text_lines is None:
            text_lines = read_text(image, config["ppocr"])
        boxes = [line["box"] for line in text_lines if line["score"] >= settings["min_text_score"]]
        box = union_box(boxes, width, height, settings["margin"])
        if box is None:
            return image, None
        x1, y1, x2, y2 = box
        return image[y1:y2, x1:x2], box

    if mode == "sam3_cached":
        if photo_id is None:
            raise ValueError("crop mode sam3_cached needs a photo_id to find the cached crop")
        path = REPO / settings["sam3_cache_dir"] / f"{photo_id}.png"
        cached = cv2.imread(str(path))
        if cached is None:
            raise FileNotFoundError(f"No cached SAM 3 crop at {path}")
        return cached, None

    raise ValueError(f"Unknown crop mode: {mode!r}")
