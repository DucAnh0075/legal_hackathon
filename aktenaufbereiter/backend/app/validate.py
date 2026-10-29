"""Deterministische Prüfung: jede Fundstelle muss auf Dokument und Zeile zeigen."""
from __future__ import annotations

from .schemas import Case, Document, Fundstelle, TextLine


def blatt_label(d: Document, line: TextLine | None = None) -> str:
    """Bei Sammelakten: handschriftliches Blatt der Zeile bzw. PDF-Seite; sonst virtuelle Blattzahl."""
    if line and line.blatt:
        return f"Bl. {line.blatt}"
    if line and line.seite:
        return f"S. {line.seite}"
    if d.aus_sammelakte:
        pages = f"S. {d.blatt_von}" if d.blatt_von == d.blatt_bis else f"S. {d.blatt_von}–{d.blatt_bis}"
        return f"Bl. {d.blatt_hand} ({pages})" if d.blatt_hand else pages
    return f"Bl. {d.blatt_von}" if d.blatt_von == d.blatt_bis else f"Bl. {d.blatt_von}–{d.blatt_bis}"


def _walk(case: Case):
    for coll in (case.personen, case.entitaeten, case.ereignisse, case.aussagen, case.beziehungen,
                 case.tatkomplexe, case.fristen, case.offene_fragen):
        for item in coll:
            yield item.id, item.fundstellen
    for w in case.widersprueche:
        for v in w.varianten:
            yield w.id, v.fundstellen


def validate(case: Case) -> None:
    docs = {d.id: d for d in case.dokumente}
    anchors = {d.id: {l.anchor: l for l in d.text_lines} for d in case.dokumente}
    case.warnungen = []
    for rid, fs in _walk(case):
        for f in fs:
            d = docs.get(f.doc_id)
            if d is None:
                f.unklar = True
                case.warnungen.append(f"{rid}: unbekanntes Dokument {f.doc_id}")
                continue
            f.blatt = blatt_label(d, anchors[f.doc_id].get(f.line or ""))
            if f.line and f.line not in anchors[f.doc_id]:
                f.unklar = True
                case.warnungen.append(f"{rid}: Anker {f.line} nicht im Dokument")
        if not fs:
            case.warnungen.append(f"{rid}: ohne Fundstelle")
