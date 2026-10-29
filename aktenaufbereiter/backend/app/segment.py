"""Gliederung einer mehrseitigen Sammel-PDF (echte Akte) in Aktenstücke."""
from __future__ import annotations

import asyncio
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Callable

from pypdf import PdfReader, PdfWriter

from . import config
from .ingest import MIN_PDF_TEXT, next_free_id, pdf_pages
from .llm import ask
from .prompts import SYSTEM, page_prompt
from .schemas import Document, PageScan, Representation, TextLine


def _page_text(pdf: Path, n: int) -> str:
    r = subprocess.run(["pdftotext", "-layout", "-f", str(n), "-l", str(n), str(pdf), "-"], capture_output=True, text=True)
    return r.stdout.strip()


def _page_image(pdf: Path, n: int, workdir: Path) -> Path:
    out = workdir / f"seite_{n:03d}"
    subprocess.run(["pdftoppm", "-r", "150", "-png", "-singlefile", "-f", str(n), "-l", str(n), str(pdf), str(out)], check=True)
    return out.with_suffix(".png")


async def _scan_page(pdf: Path, n: int, total: int, sem: asyncio.Semaphore, progress: Callable[[str], None],
                     cache: Path, workdir: Path) -> tuple[PageScan, bool]:
    cached = cache / f"_seite_{re.sub(r'[^A-Za-z0-9]+', '_', pdf.stem)}_{n:03d}.json"
    text = _page_text(pdf, n)
    has_text = len(text) >= MIN_PDF_TEXT
    if cached.exists():
        return PageScan.model_validate_json(cached.read_text(encoding="utf-8")), has_text
    async with sem:
        progress(f"liest Seite {n}/{total} ({'Text' if has_text else 'Scan'})")
        try:
            scan = await ask(config.MODEL_EXTRACT, SYSTEM, page_prompt(n, total, text if has_text else None), PageScan,
                             images=None if has_text else [_page_image(pdf, n, workdir)])
        except Exception as e:  # noqa: BLE001 - eine Seite darf den Lauf nicht abbrechen
            progress(f"Fehler bei Seite {n}: {e}")
            scan = PageScan(neues_dokument=False, unleserlich=[f"Seite konnte nicht gelesen werden: {str(e)[:200]}"])
    if has_text:  # Textschicht ist maßgeblich, nicht die Modellabschrift
        scan.ocr_lines = [re.sub(r"\s{2,}", "  ", l).strip() for l in text.splitlines() if l.strip()]
    cached.write_text(scan.model_dump_json(), encoding="utf-8")
    return scan, has_text


def _blatt(raw: str | None) -> str | None:
    m = re.fullmatch(r"\s*(?:Bl\.?\s*)?(\d{1,4})\s*", raw or "")
    return m.group(1) if m else None


async def segment(pdf: Path, taken: set[str], sem: asyncio.Semaphore, progress: Callable[[str], None],
                  cache: Path, outdir: Path) -> list[Document]:
    total = pdf_pages(pdf)
    workdir = Path(tempfile.mkdtemp(prefix="seiten_"))
    scans = await asyncio.gather(*[_scan_page(pdf, n, total, sem, progress, cache, workdir) for n in range(1, total + 1)])

    groups: list[list[int]] = []
    for i, (scan, _) in enumerate(scans):
        if i == 0 or scan.neues_dokument:
            groups.append([])
        groups[-1].append(i + 1)

    outdir.mkdir(parents=True, exist_ok=True)
    reader = PdfReader(str(pdf))
    docs: list[Document] = []
    for pages in groups:
        doc_id = next_free_id(taken)
        first = scans[pages[0] - 1][0]
        part = outdir / f"{doc_id}.pdf"
        w = PdfWriter()
        for n in pages:
            w.add_page(reader.pages[n - 1])
        with part.open("wb") as f:
            w.write(f)

        lines: list[TextLine] = []
        for n in pages:
            scan = scans[n - 1][0]
            for text in scan.ocr_lines:
                lines.append(TextLine(anchor=f"{doc_id}:L{len(lines) + 1:02d}", text=text, seite=n, blatt=_blatt(scan.blatt_handschriftlich)))
        blaetter = [b for n in pages if (b := _blatt(scans[n - 1][0].blatt_handschriftlich))]
        fmt = "pdf_text" if all(scans[n - 1][1] for n in pages) else "pdf_image"
        docs.append(Document(
            id=doc_id, title=first.title, doc_type=first.doc_type, format=fmt,  # type: ignore[arg-type]
            representations=[Representation(format=fmt, path=str(part))],  # type: ignore[arg-type]
            original_filename=pdf.name, dokumentdatum=first.datum, text_lines=lines,
            blatt_von=pages[0], blatt_bis=pages[-1], aus_sammelakte=True,
            blatt_hand=(blaetter[0] if len(set(blaetter)) == 1 else f"{blaetter[0]}–{blaetter[-1]}") if blaetter else None,
        ))
    progress(f"{pdf.name}: {total} Seiten, gegliedert in {len(docs)} Aktenstücke")
    return docs
