"""Ingest: Aktenordner einlesen, Aktenstücke erkennen, Text bzw. Seitenbilder gewinnen."""
from __future__ import annotations

import re
import subprocess
import tempfile
from collections import defaultdict
from pathlib import Path

from .schemas import DateValue, Document, Representation, TextLine

ID_RE = re.compile(r"(?<![A-Za-z0-9])([A-Z]\d{2})(?![0-9])")
ANCHOR_RE = re.compile(r"\[([A-Z]\d{2}:L\d{2,3})\]\s*(.*)")
IMG_EXT = {".png", ".jpg", ".jpeg", ".webp"}
MIN_PDF_TEXT = 40  # darunter gilt ein PDF als Bild-PDF ohne Textschicht
FORMAT_RANK = {"md": 0, "pdf_text": 1, "pdf_image": 2, "image": 3}


def doc_id_from_name(name: str) -> str | None:
    m = ID_RE.findall(Path(name).stem)
    return m[-1] if m else None


def _pdf_text(path: Path) -> str:
    r = subprocess.run(["pdftotext", "-layout", str(path), "-"], capture_output=True, text=True)
    return r.stdout if r.returncode == 0 else ""


def _lines_from_text(text: str) -> list[TextLine]:
    """Zeilen mit Anker [A01:L03] übernehmen; fortgesetzte Zeilen werden an die vorige gehängt."""
    out: list[TextLine] = []
    for raw in text.splitlines():
        m = ANCHOR_RE.match(raw.strip())
        if m:
            out.append(TextLine(anchor=m.group(1), text=m.group(2).strip()))
        elif out and raw.strip() and not raw.strip().startswith(("SYNTHETISCHE", "FIKTIVE")):
            out[-1].text += " " + raw.strip()
    return out


def number_lines(doc_id: str, text: str, start: int = 1, **extra) -> list[TextLine]:
    """Für Texte ohne eigene Zeilenanker: nicht-leere Zeilen fortlaufend als <ID>:Lnn verankern."""
    lines = [re.sub(r"\s{2,}", "  ", l).strip() for l in text.splitlines()]
    return [TextLine(anchor=f"{doc_id}:L{start + i:02d}", text=l, **extra) for i, l in enumerate(x for x in lines if x)]


def _frontmatter(text: str) -> dict[str, str]:
    m = re.match(r"---\n(.*?)\n---\n", text, re.S)
    if not m:
        return {}
    meta = {}
    for line in m.group(1).splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            meta[k.strip()] = v.strip().strip('"')
    return meta


def _date_value(iso: str | None) -> DateValue | None:
    if not iso or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", iso):
        return None
    y, m, d = iso.split("-")
    return DateValue(iso=iso, anzeige=f"{d}.{m}.{y}")


def classify(path: Path) -> str | None:
    ext = path.suffix.lower()
    if ext == ".md":
        return "md"
    if ext in IMG_EXT:
        return "image"
    if ext == ".pdf":
        return "pdf_text" if len(_pdf_text(path).strip()) >= MIN_PDF_TEXT else "pdf_image"
    return None


def pdf_pages(path: Path) -> int:
    info = subprocess.run(["pdfinfo", str(path)], capture_output=True, text=True).stdout
    m = re.search(r"Pages:\s+(\d+)", info)
    return int(m.group(1)) if m else 1


def scan(folder: Path) -> tuple[dict[str, list[tuple[str, Path]]], list[tuple[str, Path]]]:
    """Gruppiert lesbare Dateien nach Aktenstück-ID; Dateien ohne ID kommen in eine eigene Liste."""
    groups: dict[str, list[tuple[str, Path]]] = defaultdict(list)
    unnamed: list[tuple[str, Path]] = []
    for p in sorted(folder.rglob("*")):
        if not p.is_file() or ":" in p.name or p.name.upper() == "README.MD":
            continue  # Zone.Identifier u. ä.
        fmt = classify(p)
        if not fmt:
            continue
        did = doc_id_from_name(p.name)
        if did:
            groups[did].append((fmt, p))
        else:
            unnamed.append((fmt, p))
    return dict(groups), unnamed


def next_free_id(taken: set[str]) -> str:
    """Nächste freie ID D01, D02 … (danach E01 …); trägt sie in taken ein."""
    for prefix in "DEFGHIJKLMNOPQRSTUVWXYZ":
        for n in range(1, 100):
            cand = f"{prefix}{n:02d}"
            if cand not in taken:
                taken.add(cand)
                return cand
    raise RuntimeError("Keine freie Aktenstück-ID mehr")


def build_document(doc_id: str, files: list[tuple[str, Path]]) -> Document:
    files = sorted(files, key=lambda f: FORMAT_RANK[f[0]])
    fmt, main = files[0]
    doc = Document(
        id=doc_id,
        format=fmt,  # type: ignore[arg-type]
        original_filename=main.name,
        representations=[Representation(format=f, path=str(p)) for f, p in files],  # type: ignore[arg-type]
        needs_vision=fmt in ("pdf_image", "image"),
    )
    if fmt == "md":
        text = main.read_text(encoding="utf-8")
        meta = _frontmatter(text)
        doc.doc_type = meta.get("document_type", "")
        doc.dokumentdatum = _date_value(meta.get("document_date"))
        h = re.search(r"^#\s*[A-Z]\d{2}\s*\|\s*(.+)$", text, re.M)
        doc.title = h.group(1).strip() if h else ""
        doc.text_lines = _lines_from_text(text)
    elif fmt == "pdf_text":
        text = _pdf_text(main)
        doc.text_lines = _lines_from_text(text)
        h = re.search(r"[A-Z]\d{2}\s*/\s*(.+)", text)
        doc.title = h.group(1).strip() if h else ""
        m = re.search(r"Dokumentdatum\s*(\d{4}-\d{2}-\d{2})", text)
        doc.dokumentdatum = _date_value(m.group(1) if m else None)
        t = re.search(r"^\s*(\S[^|\n]*?)\s*\|\s*Dokumentdatum", text, re.M)
        doc.doc_type = t.group(1).strip() if t else ""
    if fmt in ("md", "pdf_text") and not doc.text_lines:
        doc.text_lines = number_lines(doc_id, main.read_text(encoding="utf-8") if fmt == "md" else _pdf_text(main))
    return doc


def page_images(doc: Document, workdir: Path | None = None) -> list[Path]:
    """Seitenbilder für das Vision-Modell (Bild direkt, Bild-PDF via pdftoppm)."""
    main = Path(next(r.path for r in doc.representations if r.format == doc.format))
    if doc.format == "image":
        return [main]
    workdir = workdir or Path(tempfile.mkdtemp(prefix="akte_"))
    prefix = workdir / f"{doc.id}"
    subprocess.run(["pdftoppm", "-r", "150", "-png", str(main), str(prefix)], check=True)
    return sorted(workdir.glob(f"{doc.id}*.png"))


def ingest(folder: Path, taken: set[str], skip_files: set[str] = frozenset()) -> tuple[list[Document], list[Path], int]:
    """Liefert (Aktenstücke, mehrseitige PDFs ohne ID zur Gliederung, Anzahl lesbarer Dateien)."""
    groups, unnamed = scan(folder)
    docs = [build_document(i, groups[i]) for i in sorted(groups)]
    taken |= set(groups)
    sammel: list[Path] = []
    for fmt, p in unnamed:
        if p.name in skip_files:
            continue
        if fmt.startswith("pdf") and pdf_pages(p) > 1:
            sammel.append(p)
        else:
            docs.append(build_document(next_free_id(taken), [(fmt, p)]))
    return docs, sammel, sum(len(v) for v in groups.values()) + len(unnamed)


def assign_blatt(docs: list[Document], start: int = 1) -> None:
    """Aktenstücke ohne Blatt nach Dokumentdatum/ID sortieren und virtuelle Blätter ab start vergeben.
    Stücke aus einer Sammelakte behalten ihre Seiten und Reihenfolge."""
    loose = sorted([d for d in docs if d.blatt_von is None],
                   key=lambda d: ((d.dokumentdatum.iso if d.dokumentdatum and d.dokumentdatum.iso else "9999"), d.id))
    n = max([start - 1] + [d.blatt_bis or 0 for d in docs if d.blatt_von is not None]) + 1
    for d in loose:
        pages = 1
        if d.format in ("pdf_text", "pdf_image"):
            pages = pdf_pages(Path(next(r.path for r in d.representations if r.format == d.format)))
        d.blatt_von, d.blatt_bis = n, n + pages - 1
        n += pages
    docs.sort(key=lambda d: d.blatt_von or 0)
