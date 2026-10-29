"""Tabellensichten nach der Vorlage (Spalten wie im Prompt). Wird von API und Excel-Export genutzt."""
from __future__ import annotations

import re

from .schemas import Case, DateValue, Document, Fundstelle
from .validate import blatt_label


def akten_reihenfolge(docs: list[Document]) -> list[Document]:
    physisch = sorted(docs, key=lambda d: d.blatt_von if d.blatt_von is not None else float("inf"))
    gruppen = [[], [], [], [], []]
    anlagen = False
    for d in physisch:
        meta = f"{d.doc_type} {d.title}"
        anzeige = any(re.search(r"strafanzeige|^anzeige", x, re.I) for x in (d.doc_type, d.title))
        fremd = (bool(d.herkunft) and d.herkunft != "Polizei") or re.search(
            r"haftbefehl|beschluss|verfügung|anklage|urteil|ladung|zustellung|staatsanwaltschaft|gericht|bundeszentralregister|gesetz", meta, re.I)
        if fremd:
            anlagen = False
        polizei = d.herkunft == "Polizei" or (not d.herkunft and re.search(
            r"polizei|kriminal|\bKHK\b|\bKOK\b|\bPOK\b|\bPHK\b|ermittlungsvermerk|vernehmung|asservat|sicherstellung|durchsuchung",
            meta + " " + " ".join(l.text for l in d.text_lines[:20]), re.I))
        if re.search(r"aktendeckel|aktenblatt|aktenumschlag|deckblatt", meta, re.I):
            gruppe = 0
        elif re.search(r"zählblatt|zaehlblatt|pebb", meta, re.I):
            gruppe = 1
        elif anzeige:
            gruppe = 2
            anlagen = True
        elif (polizei or anlagen) and not fremd:
            gruppe = 3
            anlagen = anlagen and not polizei  # Anlagen nur unmittelbar hinter der Anzeige
        else:
            gruppe = 4
        gruppen[gruppe].append(d)
    gruppen[4].sort(key=lambda d: d.dokumentdatum.iso if d.dokumentdatum and d.dokumentdatum.iso else "9999")
    return [d for gruppe in gruppen for d in gruppe]


def nachname(name: str) -> str:
    name = re.sub(r"\([^)]*\)|\[unleserlich\]", "", name, flags=re.I)
    name = re.sub(r"\b(?:Dr|Prof|Dipl\.-[\w-]+|KHK|KOK|POK|PHK|PK|EKHK|KHM|PHM|PM|RA|RAin|Rechtsanwalt|Rechtsanwältin)\b\.?", "", name, flags=re.I).strip()
    return name.split(",", 1)[0].strip() if "," in name else (name.split()[-1] if name.split() else "")


def _name_key(name: str, person: bool = True) -> tuple[str, str]:
    norm = lambda s: s.casefold().translate(str.maketrans({"ä": "a", "ö": "o", "ü": "u", "ß": "ss"}))
    return norm(nachname(name) if person else name), norm(name)


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
    personen = {p.id for p in case.personen}
    richter = {p.id for p in case.personen if any(re.search("richter", r, re.I) for r in p.rollen)}
    beziehungen = sorted((r for r in case.beziehungen if r.von not in richter and r.zu not in richter),
                         key=lambda r: (_name_key(name.get(r.von, r.von), r.von in personen),
                                        _name_key(name.get(r.zu, r.zu), r.zu in personen)))
    a = lambda rid, f: ann.get(rid, {}).get(f, "offen")  # noqa: E731
    docs = {d.id: d for d in case.dokumente}

    blatt = blatt_label

    t: dict[str, dict] = {}
    verfahren = case.massenverfahren.verfahren if case.massenverfahren else []
    buchstaben = {v.case_id: v.buchstabe for v in verfahren}
    if case.massenverfahren:
        rows = []
        for v in sorted(verfahren, key=lambda v: (not bool(v.klageeingang and v.klageeingang.iso),
                                                  v.klageeingang.iso or "" if v.klageeingang else "")):
            fundstellen = [v.klageeingang_fundstelle] if v.klageeingang_fundstelle else []
            fundstellen += [f for m in v.merkmale for f in m.fundstellen]
            doc = fundstellen[0].doc_id if fundstellen else next(
                (d.id for d in case.dokumente if d.id.startswith(v.buchstabe)), None)
            rows.append({"id": v.buchstabe, "doc": doc,
                         "cells": [v.buchstabe, dv(v.klageeingang), v.name, "; ".join(v.aktivseite),
                                   "; ".join(v.gegenseite), "; ".join(f"{m.art}: {m.wert}" for m in v.merkmale),
                                   fs(fundstellen)]})
        t["einzelverfahren"] = {"title": "0. Einzelverfahren (nach Klageeingang)",
                               "cols": ["Verfahren", "Eingang", "Akte", "Aktivseite", "Gegenseite", "Merkmale", "Fundstelle"],
                               "rows": rows}
    mit_verfahren = any(d.quelle_akte for d in case.dokumente)
    t["akte"] = {"title": "1. Aktenübersicht",
                 "cols": ["#", "Blatt"] + (["Verfahren"] if mit_verfahren else []) + ["Datum", "Vorgang", "Essentialia"],
                 "rows": [{"id": d.id, "doc": d.id,
                           "cells": [i + 1, blatt(d)]
                           + ([buchstaben.get(d.quelle_akte, d.quelle_akte or "")] if mit_verfahren else [])
                           + [dv(d.dokumentdatum), f"{d.id} {d.doc_type}: {d.title}", d.essentialia]}
                          for i, d in enumerate(akten_reihenfolge(case.dokumente))]}
    t["personen"] = {"title": "2. Personenverzeichnis", "cols": ["#", "Name", "Adresse", "Prozessrolle", "Blatt"],
                     "rows": [{"id": p.id, "doc": p.fundstellen[0].doc_id if p.fundstellen else None,
                               "cells": [i + 1, p.name + (f" (auch: {', '.join(p.aliases)})" if p.aliases else ""), p.adresse, "; ".join(p.rollen), fs(p.fundstellen)]}
                              for i, p in enumerate(sorted(case.personen, key=lambda p: _name_key(p.name)))]}
    t["tatkomplexe"] = {"title": "3. Tatkomplex- und Vorwurfsverzeichnis", "cols": ["Tatkomplex", "Tatvorwurf / Norm", "Tatzeitraum", "Betroffene Personen", "Beweismittel"],
                        "rows": [{"id": k.id, "doc": k.beweismittel[0] if k.beweismittel else None,
                                  "cells": [k.label, k.vorwurf_laut_akte, k.zeitraum, ", ".join(name.get(p, p) for p in k.personen), ", ".join(k.beweismittel)]}
                                 for k in case.tatkomplexe]}
    t["beziehungen"] = {"title": "4. Beziehungsverzeichnis", "cols": ["Person 1", "Beziehung", "Person 2", "Fundstelle", "Bemerkungen"],
                        "rows": [{"id": r.id, "doc": r.fundstellen[0].doc_id if r.fundstellen else None,
                                  "cells": [name.get(r.von, r.von), r.beziehung, name.get(r.zu, r.zu), fs(r.fundstellen), r.bemerkung or ""]}
                                 for r in beziehungen]}

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
    _ = docs
    return t
