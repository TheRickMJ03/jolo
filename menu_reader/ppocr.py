"""PP-OCRv6 on CPU: text lines with a confidence score and a box each.

Used for cropping (where is the text?) and later as a confidence signal.
The models load once, on first use.
"""

import numpy as np

_ocr = None


def _get_ocr(settings):
    global _ocr
    if _ocr is None:
        from paddleocr import PaddleOCR   # slow import, so only when needed

        _ocr = PaddleOCR(
            text_detection_model_name=settings["detection_model"],
            text_recognition_model_name=settings["recognition_model"],
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False,
            device=settings["device"],
            enable_mkldnn=settings["enable_mkldnn"],
        )
    return _ocr


def _field(result, key):
    """The docs print results wrapped in a 'res' key, so try both forms."""
    try:
        return result[key]
    except (KeyError, TypeError):
        return result.json["res"][key]


def read_text(image, settings):
    """Run PP-OCRv6 on a BGR image.

    Returns a list of lines: {"text", "score", "poly", "box"}.
    poly is the 4-corner outline; box is (x1, y1, x2, y2) around it.
    """
    result = list(_get_ocr(settings).predict(image))[0]
    lines = []
    for text, score, poly in zip(_field(result, "rec_texts"),
                                 _field(result, "rec_scores"),
                                 _field(result, "rec_polys")):
        points = np.array(poly, dtype=float).reshape(-1, 2)
        x1, y1 = points.min(axis=0)
        x2, y2 = points.max(axis=0)
        lines.append({
            "text": text,
            "score": float(score),
            "poly": points.round().astype(int).tolist(),
            "box": (int(x1), int(y1), int(x2), int(y2)),
        })
    return lines
