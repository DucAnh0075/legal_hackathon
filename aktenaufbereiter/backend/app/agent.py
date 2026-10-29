"""Pipeline: Ingest -> Extraktion je Dokument -> Konsolidierung -> Validierung -> Speichern."""
from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path
from typing import Callable

from . import config, store
from .ingest import assign_blatt, ingest, page_images
from .segment import segment
from .llm import ask
from .prompts import SYSTEM, consolidate_prompt, extract_prompt
from .schemas import Case, Consolidation, ConsEntities, ConsEvents, ConsRest, ConsStatements, DocExtraction, Document
from .validate import blatt_label, drop_trivial, validate

Progress = Callable[[str], None]
COLLECTIONS = ["personen", "entitaeten", "ereignisse", "aussagen", "widersprueche", "beziehungen",
               "tatkomplexe", "fristen", "offene_fragen"]


async def _extract(doc: Document, sem: asyncio.Semaphore, progress: Progress, cache: Path) -> DocExtraction:
    cached = cache / f"{doc.id}.json"
    if cached.exists():
        progress(f"{doc.id} aus Zwischenspeicher")
        return DocExtraction.model_validate_json(cached.read_text(encoding="utf-8"))
    async with sem:
        kind = "Bild" if doc.needs_vision else doc.format
        progress(f"liest {doc.id} ({kind})")
        images = page_images(doc, Path(tempfile.mkdtemp(prefix="akte_"))) if doc.needs_vision else None
        text = "\n".join(f"[{l.anchor}] {l.text}" for l in doc.text_lines) if not doc.needs_vision else None
        try:
            ex = await ask(config.MODEL_EXTRACT, SYSTEM, extract_prompt(doc.id, text, doc.needs_vision),
                           DocExtraction, images=images)
        except Exception as e:  # noqa: BLE001 - ein Dokument darf den Lauf nicht abbrechen
            progress(f"Fehler bei {doc.id}: {e}")
            return DocExtraction(doc_id=doc.id, title="", doc_type="", essentialia="",
                                 offene_fragen=[f"Extraktion fehlgeschlagen: {str(e)[:200]}"])
        ex.doc_id = doc.id
        cached.write_text(ex.model_dump_json(), encoding="utf-8")
        progress(f"fertig {doc.id}")
        return ex


def _apply(doc: Document, ex: DocExtraction) -> None:
    doc.title = doc.title or ex.title
    doc.doc_type = doc.doc_type or ex.doc_type
    doc.dokumentdatum = doc.dokumentdatum or ex.dokumentdatum
    doc.herkunft = ex.herkunft
    doc.eingangsdatum = ex.eingangsdatum
    doc.essentialia = ex.essentialia
    if doc.needs_vision:
        doc.text_lines = ex.ocr_lines


def _merge_append_only(new: Consolidation, old: Case) -> None:
    """Bestehende Zeilen bleiben unverändert; das Modell darf nur ergänzen."""
    for name in COLLECTIONS:
        old_items = {i.id: i for i in getattr(old, name)}
        merged = list(old_items.values())
        merged += [i for i in getattr(new, name) if i.id not in old_items]
        setattr(new, name, merged)


async def _part(name: str, schema, extractions, blatt, registry, existing: Case | None, cache: Path, progress: Progress):
    cached = cache / f"_kons_{name}.json"
    if cached.exists():
        return schema.model_validate_json(cached.read_text(encoding="utf-8"))
    progress(f"konsolidiert: {name}")
    prev = existing.model_dump_json(include=set(schema.model_fields)) if existing else None
    out = await ask(config.MODEL_CONSOLIDATE, SYSTEM, consolidate_prompt(name, schema, extractions, blatt, registry, prev),
                    schema, max_tokens=32000)
    cached.write_text(out.model_dump_json(), encoding="utf-8")
    progress(f"fertig: {name}")
    return out


async def _consolidate(extractions, blatt, existing: Case | None, cache: Path, progress: Progress) -> Consolidation:
    """Erst Register (Personen/Entitäten), dann Ereignisse, Aussagen/Widersprüche und Rest parallel."""
    ents = await _part("entities", ConsEntities, extractions, blatt, None, existing, cache, progress)
    reg_src = ConsEntities(personen=(existing.personen if existing else []) + ents.personen,
                           entitaeten=(existing.entitaeten if existing else []) + ents.entitaeten)
    registry = "\n".join([f"{p.id}: {p.name}" + (f" (auch {', '.join(p.aliases)})" if p.aliases else "") for p in reg_src.personen]
                          + [f"{e.id}: {e.label} [{e.typ}]" for e in reg_src.entitaeten])
    evs, sts, rest = await asyncio.gather(*[
        _part(n, sc, extractions, blatt, registry, existing, cache, progress)
        for n, sc in (("events", ConsEvents), ("statements", ConsStatements), ("rest", ConsRest))])
    return Consolidation(**ents.model_dump(), **evs.model_dump(), **sts.model_dump(), **rest.model_dump())


async def run(folder: Path, case_id: str, name: str | None = None, progress: Progress = print) -> Case:
    existing = store.load_case(case_id)
    known = {d.id for d in existing.dokumente} if existing else set()
    known_files = {Path(r.path).name for d in existing.dokumente for r in d.representations} | \
        {d.original_filename for d in existing.dokumente} if existing else set()
    taken = set(known)
    docs, sammel, n_files = ingest(folder, taken, known_files)
    if n_files == 0:
        raise RuntimeError("Keine lesbaren Dateien gefunden (PDF, Markdown, PNG/JPG).")
    docs = [d for d in docs if d.id not in known]

    sem = asyncio.Semaphore(config.CONCURRENCY)
    cache = store.case_dir(case_id) / "extraktionen"
    cache.mkdir(parents=True, exist_ok=True)
    offset = max((d.blatt_bis or 0 for d in existing.dokumente), default=0) if existing else 0
    for pdf in sammel:
        progress(f"gliedert Sammelakte {pdf.name}")
        parts = await segment(pdf, taken, sem, progress, cache, store.case_dir(case_id) / "segmente")
        for d in parts:  # Seiten hinter Bestand und vorherige Sammelakten hängen
            d.blatt_von, d.blatt_bis = d.blatt_von + offset, d.blatt_bis + offset
        offset = max(d.blatt_bis for d in parts)
        docs += parts
    if not docs:
        raise RuntimeError("Alle Aktenstücke sind in dieser Akte bereits vorhanden.")
    progress(f"{len(docs)} Aktenstücke erkannt")

    extractions = await asyncio.gather(*[_extract(d, sem, progress, cache) for d in docs])
    failed = [ex.doc_id for ex in extractions if not ex.essentialia and ex.offene_fragen[:1] and ex.offene_fragen[0].startswith("Extraktion fehlgeschlagen")]
    if len(failed) == len(docs):
        raise RuntimeError(f"Extraktion für alle Aktenstücke fehlgeschlagen. {extractions[0].offene_fragen[0]}")
    for d, ex in zip(docs, extractions):
        _apply(d, ex)

    all_docs = (existing.dokumente if existing else []) + docs
    assign_blatt(docs, start=offset + 1)  # Bestandsblätter bleiben, neue Stücke werden angehängt
    store.sort_files(case_id, docs)

    blatt = {d.id: blatt_label(d) for d in all_docs}
    cons = await _consolidate(extractions, blatt, existing, store.case_dir(case_id) / "extraktionen", progress)
    if existing:
        _merge_append_only(cons, existing)

    case = Case(id=case_id, name=name or (existing.name if existing else case_id),
                dokumente=sorted(all_docs, key=lambda d: d.blatt_von or 0), **cons.model_dump())
    drop_trivial(case)
    validate(case)
    case.warnungen += [f"{d}: Extraktion fehlgeschlagen" for d in failed]
    gespeichert = case.model_copy(deep=True)
    if existing:
        # Die gefilterte Sicht darf beim Ergänzen keine Bestandseinträge entfernen.
        _merge_append_only(gespeichert, existing)
    store.save_case(gespeichert)
    try:
        from .review import review

        await review(store.load_case(case_id), progress)
    except Exception as e:
        progress(f"Review fehlgeschlagen: {e}")
    try:
        from . import board, review as review_cache, view

        sicht = gespeichert.model_copy(deep=True)
        view.apply(sicht, review_cache.load(case_id))
        await board.build_board(sicht, progress)
    except Exception as e:
        progress(f"Beweisboard fehlgeschlagen: {e}")
    for f in (store.case_dir(case_id) / "extraktionen").glob("_kons_*.json"):
        f.unlink()  # Teilkonsolidierungen gelten nur bis zum erfolgreichen Abschluss
    progress(f"gespeichert ({len(case.warnungen)} Validierungshinweise)")
    return case
