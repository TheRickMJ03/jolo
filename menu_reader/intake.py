"""Intake: open a photo (HEIC/WEBP/JPEG/PNG), fix rotation, resize, measure blur."""

import io
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageOps
from pillow_heif import register_heif_opener

register_heif_opener()  # lets Pillow open .heic files


@dataclass
class IntakeResult:
    image: np.ndarray | None        # BGR, as OpenCV expects. None if the file can't be opened.
    readable: bool
    reason: str | None              # e.g. "unreadable_file", "blurry"
    original_size: tuple | None     # (width, height) before resizing
    blur_score: float | None        # higher = sharper


def blur_score(image):
    """Variance of the Laplacian: low when the photo has few sharp edges.

    The photo is shrunk to a fixed size first so scores are comparable
    between a 12-megapixel photo and a small web image.
    """
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    longest = max(gray.shape)
    if longest > 1000:
        scale = 1000 / longest
        gray = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def load_image(source, max_side_px=2000, blur_threshold=None):
    """Open a photo from a path or raw bytes.

    - Applies the phone's EXIF rotation so the image is upright.
    - Shrinks it so the longest side is at most max_side_px (never enlarges).
    - Marks it unreadable with reason "blurry" if blur_threshold is set and
      the blur score is below it.
    """
    try:
        if isinstance(source, (bytes, bytearray)):
            pil_image = Image.open(io.BytesIO(source))
        else:
            pil_image = Image.open(Path(source))
        pil_image = ImageOps.exif_transpose(pil_image).convert("RGB")
    except Exception:
        return IntakeResult(None, False, "unreadable_file", None, None)

    original_size = pil_image.size
    pil_image.thumbnail((max_side_px, max_side_px))
    image = cv2.cvtColor(np.array(pil_image), cv2.COLOR_RGB2BGR)

    score = blur_score(image)
    if blur_threshold is not None and score < blur_threshold:
        return IntakeResult(image, False, "blurry", original_size, score)
    return IntakeResult(image, True, None, original_size, score)
