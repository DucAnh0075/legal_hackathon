"""Zeilenkästen im Original und Zuordnung vorhandener Aktenanker."""
from __future__ import annotations

import json
import re
import subprocess
import tempfile
import xml.etree.ElementTree as ET
from difflib import SequenceMatcher
from pathlib import Path
from threading import Lock

from . import store
from .ingest import pdf_pages
from .schemas import Document

_engine = None
_ocr_lock = Lock()


def _ocr(path: Path, page: int) -> list[dict]:
    global _engine
    try:
        from PIL import Image
        from rapidocr import RapidOCR

        with _ocr_lock:
            if _engine is None:
                _engine = RapidOCR()
            result = _engine(str(path))
        if result.boxes is None:
            return []
        with Image.open(path) as im:
            width, height = im.size
        boxes = []
        for points, text in zip(result.boxes, result.txts):
            x1, y1 = points.min(axis=0)
            x2, y2 = points.max(axis=0)
            boxes.append(_box(page, x1, y1, x2, y2, width, height, text))
        return boxes
    except Exception:  # OCR ist optional; das Original bleibt abrufbar.
        return []


def _box(page, x1, y1, x2, y2, width, height, text) -> dict:
    x, y = max(0., min(1., float(x1) / width)), max(0., min(1., float(y1) / height))
    return {"page": page, "x": x, "y": y, "w": max(0., min(1., float(x2) / width) - x),
            "h": max(0., min(1., float(y2) / height) - y), "text": text}


def _boxes(case_id: str, doc: Document, fmt: str) -> list[dict]:
    rep = next((r for r in doc.representations if r.format == fmt), None)
    if not rep or not rep.sorted_path:
        return []
    path = store.case_dir(case_id) / rep.sorted_path
    cache = store.case_dir(case_id) / "boxes" / f"{doc.id}_{fmt}.json"
    if cache.exists():
        return json.loads(cache.read_text(encoding="utf-8"))
    boxes = []
    if fmt == "pdf_text":
        result = subprocess.run(["pdftotext", "-bbox-layout", str(path), "-"], capture_output=True, check=True)
        root = ET.fromstring(result.stdout)
        for n, page in enumerate(root.findall(".//{*}page"), 1):
            width, height = float(page.attrib["width"]), float(page.attrib["height"])
            for line in page.findall(".//{*}line"):
                a = line.attrib
                text = " ".join("".join(w.itertext()) for w in line.findall("{*}word"))
                boxes.append(_box(n, *[float(a[k]) for k in ("xMin", "yMin", "xMax", "yMax")], width, height, text))
    elif fmt == "pdf_image":
        with tempfile.TemporaryDirectory(prefix="mark_") as tmp:
            for n in range(1, pdf_pages(path) + 1):
                prefix = Path(tmp) / str(n)
                subprocess.run(["pdftoppm", "-r", "150", "-png", "-singlefile", "-f", str(n), "-l", str(n),
                                str(path), str(prefix)], capture_output=True, check=True)
                boxes.extend(_ocr(prefix.with_suffix(".png"), n))
    elif fmt == "image":
        boxes = _ocr(path, 1)
    if boxes:  # Fehlgeschlagene OCR beim nächsten Abruf erneut versuchen.
        cache.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(mode="w", dir=cache.parent, encoding="utf-8", delete=False) as f:
            json.dump(boxes, f, ensure_ascii=False)
        Path(f.name).replace(cache)
    return boxes


def find_marks(case_id: str, doc: Document, fmt: str | None, anchors: list[str]) -> dict:
    fmt = fmt or next((r.format for r in doc.representations if r.format != "md"), doc.format)
    boxes = _boxes(case_id, doc, fmt)
    lines = {l.anchor: l for l in doc.text_lines}
    first = doc.text_lines[0].seite if doc.text_lines else None
    norm = lambda s: " ".join(re.sub(r"[^\w\s]", "", s.lower()).split())
    out = {"fmt": fmt, "page": None, "boxes": [], "found": [], "missing": []}
    fallback = None
    for anchor in anchors:
        line = lines.get(anchor)
        if line is None:
            out["missing"].append(anchor)
            continue
        page = line.seite - first + 1 if line.seite is not None and first is not None else None
        if fallback is None:
            fallback = page
        candidates = [b for b in boxes if page is None or b["page"] == page]
        best, score = [], 0.
        target = norm(line.text)
        for i, box in enumerate(candidates):
            for size in range(1, 4):
                group = candidates[i:i + size]
                if len(group) != size or group[-1]["page"] != box["page"]:
                    continue
                ratio = SequenceMatcher(None, target, norm(" ".join(b["text"] for b in group))).ratio()
                if ratio > score:
                    best, score = group, ratio
        if score < 0.55:
            out["missing"].append(anchor)
            continue
        out["found"].append(anchor)
        if out["page"] is None:
            out["page"] = best[0]["page"]
        for b in best:
            coords = {k: v for k, v in b.items() if k != "text"}
            if coords not in out["boxes"]:
                out["boxes"].append(coords)
    if out["page"] is None:
        out["page"] = fallback
    return out


def marked_pdf(path: Path, boxes: list[dict]) -> bytes:
    from io import BytesIO
    from pypdf import PdfReader, PdfWriter
    from pypdf.annotations import Highlight
    from pypdf.generic import ArrayObject, FloatObject

    writer = PdfWriter()
    writer.append(PdfReader(path))
    for box in boxes:
        page = writer.pages[box["page"] - 1]
        m = page.mediabox
        left, bottom, width, height = map(float, (m.left, m.bottom, m.width, m.height))
        x1 = max(left, left + box["x"] * width - 2)
        x2 = min(left + width, left + (box["x"] + box["w"]) * width + 2)
        y1 = max(bottom, bottom + (1 - box["y"] - box["h"]) * height - 2)
        y2 = min(bottom + height, bottom + (1 - box["y"]) * height + 2)
        annot = Highlight(rect=(x1, y1, x2, y2),
                          quad_points=ArrayObject([FloatObject(v) for v in (x1, y2, x2, y2, x1, y1, x2, y1)]),
                          highlight_color="ffeb3b")
        writer.add_annotation(box["page"] - 1, annot)
    out = BytesIO()
    writer.write(out)
    return out.getvalue()
