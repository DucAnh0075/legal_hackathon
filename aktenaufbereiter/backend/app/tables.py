"""Tabellensichten nach der Vorlage (Spalten wie im Prompt). Wird von API und Excel-Export genutzt."""
from __future__ import annotations

from .schemas import Case, DateValue, Fundstelle
from .validate import blatt_label


def fs(fundstellen: list[Fundstelle]) -> str:
    parts = []
    for f in fundstellen:
        s = f"{f.blatt or '?'} ({f.line or f.doc_id})"
        parts.append(s + (" [Fundstelle unklar]" if f.unklar else ""))
    return "; ".join(dict.fromkeys(parts))


def dv(d: DateValue | None) -> str:
    if not d:
        return ""
    return (d.anzeige or "") + (f" ({d.hinweis})" if d.hinweis else "")


def build(case: Case, ann: dict) -> dict[str, dict]:
    name = {p.id: p.name for p in case.personen} | {e.id: e.label for e in case.entitaeten}
    a = lambda rid, f: ann.get(rid, {}).get(f, "offen")  # noqa: E731
    docs = {d.id: d for d in case.dokumente}

    blatt = blatt_label

    t: dict[str, dict] = {}
    t["akte"] = {"title": "1. Aktenübersicht", "cols": ["#", "Blatt", "Datum", "Vorgang", "Essentialia", "Anmerkung Kanzlei", "Anmerkung Mandant"],
                 "rows": [{"id": d.id, "doc": d.id, "cells": [i + 1, blatt(d), dv(d.dokumentdatum), f"{d.id} {d.doc_type}: {d.title}", d.essentialia, a(d.id, "kanzlei"), a(d.id, "mandant")]}
                          for i, d in enumerate(case.dokumente)]}
    t["personen"] = {"title": "2. Personenverzeichnis", "cols": ["#", "Name", "Adresse", "Prozessrolle", "Blatt", "Anmerkung Kanzlei", "Anmerkung Mandant"],
                     "rows": [{"id": p.id, "doc": p.fundstellen[0].doc_id if p.fundstellen else None,
                               "cells": [i + 1, p.name + (f" (auch: {', '.join(p.aliases)})" if p.aliases else ""), p.adresse, "; ".join(p.rollen), fs(p.fundstellen), a(p.id, "kanzlei"), a(p.id, "mandant")]}
                              for i, p in enumerate(case.personen)]}
    t["tatkomplexe"] = {"title": "3. Tatkomplex- und Vorwurfsverzeichnis", "cols": ["Tatkomplex", "Tatvorwurf / Norm", "Tatzeitraum", "Betroffene Personen", "Beweismittel"],
                        "rows": [{"id": k.id, "doc": k.beweismittel[0] if k.beweismittel else None,
                                  "cells": [k.label, k.vorwurf_laut_akte, k.zeitraum, ", ".join(name.get(p, p) for p in k.personen), ", ".join(k.beweismittel)]}
                                 for k in case.tatkomplexe]}
    t["beziehungen"] = {"title": "4. Beziehungsverzeichnis", "cols": ["Person 1", "Beziehung", "Person 2", "Fundstelle", "Bemerkungen"],
                        "rows": [{"id": r.id, "doc": r.fundstellen[0].doc_id if r.fundstellen else None,
                                  "cells": [name.get(r.von, r.von), r.beziehung, name.get(r.zu, r.zu), fs(r.fundstellen), r.bemerkung or ""]}
                                 for r in case.beziehungen]}

    def chron(kind: str):
        evs = sorted([e for e in case.ereignisse if e.kind == kind], key=lambda e: (e.ereignisdatum.iso if e.ereignisdatum and e.ereignisdatum.iso else "9999"))
        return evs

    t["geschehen"] = {"title": "5a. Chronologie – Geschehen", "cols": ["#", "Ereignisdatum", "Blatt", "Beteiligte", "Vorgang", "Status", "Anmerkung Kanzlei", "Anmerkung Mandant"],
                      "rows": [{"id": e.id, "doc": e.fundstellen[0].doc_id if e.fundstellen else None,
                                "cells": [i + 1, dv(e.ereignisdatum), fs(e.fundstellen), ", ".join(name.get(b, b) for b in e.beteiligte), e.beschreibung, e.status, a(e.id, "kanzlei"), a(e.id, "mandant")]}
                               for i, e in enumerate(chron("geschehen"))]}
    t["verfahren"] = {"title": "5b. Chronologie – Verfahren", "cols": ["#", "Art", "Ereignisdatum", "Dokumentdatum", "Eingangsdatum", "Blatt", "Vorgang", "Anmerkung Kanzlei", "Anmerkung Mandant"],
                      "rows": [{"id": e.id, "doc": e.fundstellen[0].doc_id if e.fundstellen else None,
                                "cells": [i + 1, e.verfahrens_typ or "", dv(e.ereignisdatum), dv(e.dokumentdatum), dv(e.eingangsdatum), fs(e.fundstellen), e.beschreibung, a(e.id, "kanzlei"), a(e.id, "mandant")]}
                               for i, e in enumerate(chron("verfahren"))]}
    t["fristen"] = {"title": "6. Fristen- und Terminverzeichnis", "cols": ["Art", "Datum / Frist", "Beschreibung", "Fundstelle"],
                    "rows": [{"id": f.id, "doc": f.fundstellen[0].doc_id if f.fundstellen else None, "cells": [f.art, dv(f.datum), f.beschreibung, fs(f.fundstellen)]} for f in case.fristen]}
    t["widersprueche"] = {"title": "7. Widersprüche", "cols": ["Thema", "Variante", "Quelle", "Fundstelle"],
                          "rows": [{"id": f"{w.id}-{i}", "doc": v.fundstellen[0].doc_id if v.fundstellen else None,
                                    "cells": [w.thema if i == 0 else "", v.behauptung, name.get(v.quelle_person or "", v.quelle_person or ""), fs(v.fundstellen)]}
                                   for w in case.widersprueche for i, v in enumerate(w.varianten)]}
    t["offene_fragen"] = {"title": "8. Offene Fragen", "cols": ["Frage", "Fundstelle"],
                          "rows": [{"id": o.id, "doc": o.fundstellen[0].doc_id if o.fundstellen else None, "cells": [o.frage, fs(o.fundstellen)]} for o in case.offene_fragen]}
    _ = docs
    return t
