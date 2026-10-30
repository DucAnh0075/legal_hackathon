"""Fragen mit belegten Antworten aus einer Akte oder dem Pool."""
import hashlib
import json
import logging
import time
from difflib import SequenceMatcher

from . import config, llm, review, store, suche, view
from .prompts import SYSTEM_FRAGE, frage_prompt, pruef_prompt, suchplan_prompt
from .schemas import AktenAntwort, AntwortPruefung, Suchplan
from .validate import blatt_label


def _norm(text):
    return " ".join(text.lower().translate(str.maketrans("", "", '„“”‚‘’«»‹›')).split())


def _stellen(cases):
    return {(cid, l.anchor): (d, l) for cid, c in cases.items() for d in c.dokumente for l in d.text_lines}


def pruefen(antwort, cases, case_id) -> AktenAntwort:
    antwort = antwort.model_copy(deep=True)
    antwort.verworfen = 0  # Prüffelder setzt nur das Programm, nie das Antwortmodell
    stellen = _stellen(cases)
    behalten = []
    for a in antwort.aussagen:
        a.urteil, a.grund = None, None
        belege = []
        for b in a.belege:
            if "|" in b.line:
                b.case_id, b.line = b.line.split("|", 1)
            if case_id is not None:
                b.case_id = case_id
            b.doc_id = b.line.split(":", 1)[0]
            stelle = stellen.get((b.case_id, b.line))
            z = _norm(b.zitat)
            t = _norm(stelle[1].text) if stelle else ""
            if stelle and stelle[0].id == b.doc_id and z and (
                    z in t or SequenceMatcher(None, z, t).find_longest_match(0, len(z), 0, len(t)).size / len(z) >= 0.8):
                b.blatt = blatt_label(*stelle)
                belege.append(b)
            else:
                antwort.verworfen += 1
        a.belege = belege
        if belege:
            behalten.append(a)
        else:
            antwort.verworfen += 1
    antwort.aussagen = behalten if antwort.status != "ausserhalb" else []
    if antwort.status in ("beantwortet", "teilweise") and not antwort.aussagen:
        antwort.status = "nicht_in_akte"
    antwort.nachfragen = antwort.nachfragen[:3]
    return antwort


def dateien(antwort, cases):
    gruppen = {}
    for a in antwort.aussagen:
        for b in a.belege:
            key = (b.case_id, b.doc_id)
            if key not in gruppen:
                c = cases[b.case_id]
                d = next(d for d in c.dokumente if d.id == b.doc_id)
                gruppen[key] = {"case_id": c.id, "case_name": c.name, "doc_id": d.id,
                                "title": d.title or d.doc_type, "blatt": blatt_label(d), "anchors": []}
            if b.line not in gruppen[key]["anchors"]:
                gruppen[key]["anchors"].append(b.line)
    return sorted(gruppen.values(), key=lambda d: -len(d["anchors"]))


def _sicht(case):
    c = case.model_copy(deep=True)
    view.apply(c, review.load(c.id))
    return c


def hinweise(antwort, cases):
    zitiert = {(b.case_id, b.line) for a in antwort.aussagen for b in a.belege}
    out = []
    for cid, case in cases.items():
        c = _sicht(case)
        for art, items in (("widerspruch", c.widersprueche), ("frist", c.fristen)):
            for item in items:
                fs = [f for v in item.varianten for f in v.fundstellen] if art == "widerspruch" else item.fundstellen
                anchors = list(dict.fromkeys(f.line for f in fs if (cid, f.line) in zitiert))
                if anchors:
                    out.append({"art": art, "case_id": cid, "id": item.id,
                                "text": item.thema if art == "widerspruch" else item.beschreibung, "anchors": anchors})
    return out


def _lesen(path):
    try:
        return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    except (OSError, ValueError):
        return {}


def _zusatz(cases, case_id):
    if case_id is not None:
        c = _sicht(cases[case_id])
        return {"personen": [p.model_dump(include={"name", "rollen"}) for p in c.personen],
                "ereignisse": [{**e.model_dump(include={"kind", "ereignisdatum", "beschreibung"}),
                                "fundstellen": [f.line for f in e.fundstellen]} for e in c.ereignisse],
                "widersprueche": [w.model_dump(include={"thema", "varianten"}) for w in c.widersprueche],
                "fristen": [f.model_dump() for f in c.fristen]}
    out = []
    for cid, c in cases.items():
        p = _lesen(store.case_dir(cid) / "profil.json")
        out.append({"case_id": cid, "name": c.name, **({"gegenstand": p.get("profil", {}).get("gegenstand", "")} if p else {})})
    return out


async def beantworten(frage: str, case_id: str | None, verlauf: list[dict], emit=print) -> AktenAntwort:
    start = time.monotonic()

    def senden(**daten):
        emit({**daten, "ms": int((time.monotonic() - start) * 1000)})

    suche.sync(case_id)
    treffer = suche.suchen(suche.begriffe(frage), case_id)
    cases = {}
    ids = [case_id] if case_id is not None else [p.parent.name for p in sorted(config.CASES_DIR.glob("*/case.json"))]
    for cid in ids:
        try:
            c = store.load_case(cid)
            if c is None:
                raise ValueError("Akte nicht gefunden")
            if case_id is not None or c.massenverfahren is None:
                cases[cid] = c
        except (OSError, ValueError):
            if case_id is not None:
                raise ValueError("Akte nicht gefunden") from None
            logging.getLogger(__name__).exception("Frage: Akte %s übersprungen", cid)
    stellen = _stellen(cases)
    angereichert = []
    for t in treffer:
        stelle = stellen.get((t["case_id"], t["anchor"]))
        if stelle:
            d, l = stelle
            angereichert.append({**t, "case_name": cases[t["case_id"]].name,
                                 "doc_title": d.title or d.doc_type, "blatt": blatt_label(d, l)})
    senden(treffer=angereichert)
    bereich = hashlib.sha256()
    for cid in sorted(cases):
        bereich.update(json.dumps(cid).encode())
        bereich.update(hashlib.sha256((store.case_dir(cid) / "case.json").read_bytes()).digest())
    schluessel = hashlib.sha256(json.dumps([" ".join(frage.lower().split()), verlauf, config.MODEL_CHAT, config.FRAGE_VOLLTEXT_MAX,
                                           bereich.hexdigest()], sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    path = store.case_dir(case_id) / "antworten.json" if case_id is not None else config.CASES_DIR / "antworten_pool.json"
    cache = _lesen(path)
    if schluessel in cache:
        hit = cache[schluessel]
        antwort = AktenAntwort.model_validate(hit["antwort"])
        senden(kontext=hit["kontext"])
        senden(antwort=antwort.model_dump(), dateien=hit["dateien"], hinweise=hit["hinweise"], aus_cache=True)
        return antwort

    def doc_id(cid, d):
        return d.id if case_id is not None else f"{cid}|{d.id}"

    art = "volltext"
    auswahl = set(stellen)
    if sum(len(l.text) for d, l in stellen.values()) > config.FRAGE_VOLLTEXT_MAX:
        art = "suche"
        karte = [{"id": doc_id(cid, d), "title": d.title, "doc_type": d.doc_type, "essentialia": d.essentialia}
                 for cid, c in cases.items() for d in c.dokumente]
        plan = await llm.ask(config.MODEL_CHAT, SYSTEM_FRAGE, suchplan_prompt(frage, karte, verlauf), Suchplan, max_tokens=3000, effort=config.FRAGE_EFFORT)
        treffer = suche.suchen(suche.begriffe(frage) + plan.begriffe, case_id, limit=120)
        treffer = [t for t in treffer if (t["case_id"], t["anchor"]) in stellen]
        treffer.sort(key=lambda t: doc_id(t["case_id"], stellen[t["case_id"], t["anchor"]][0]) not in plan.dokumente)
        auswahl = set()
        for t in treffer[:80]:
            d, l = stellen[t["case_id"], t["anchor"]]
            i = d.text_lines.index(l)
            auswahl.update((t["case_id"], n.anchor) for n in d.text_lines[max(0, i - 2):i + 3])
    texte, dokumente = [], []
    for cid, c in cases.items():
        for d in c.dokumente:
            zeilen = [l for l in d.text_lines if (cid, l.anchor) in auswahl]
            if not zeilen:
                continue
            did = doc_id(cid, d)
            dokumente.append(did)
            texte.append(f"Dokument {did}: {d.title or d.doc_type} | {blatt_label(d)}")
            texte.extend(f"[{l.anchor if case_id is not None else cid + '|' + l.anchor}] {l.text}" for l in zeilen)
    kontext = "\n".join(texte) + "\n" + json.dumps(_zusatz(cases, case_id), ensure_ascii=False, separators=(",", ":"))
    info = {"art": art, "zeichen": len(kontext), "stellen": len(auswahl), "dokumente": len(dokumente),
            "dokumente_gesamt": sum(len(c.dokumente) for c in cases.values())}
    senden(kontext=info)
    antwort = await llm.ask(config.MODEL_CHAT, SYSTEM_FRAGE, frage_prompt(frage, kontext, verlauf), AktenAntwort, max_tokens=12000, effort=config.FRAGE_EFFORT)
    antwort = pruefen(antwort, cases, case_id)
    files, hints = dateien(antwort, cases), hinweise(antwort, cases)
    senden(antwort=antwort.model_dump(), dateien=files, hinweise=hints, aus_cache=False)
    gelungen = not antwort.aussagen
    if antwort.aussagen:
        try:
            daten = [{"index": i, "text": a.text,
                      "zeilen": [{"case_id": b.case_id, "line": b.line, "text": stellen[b.case_id, b.line][1].text,
                                  "dokumentkopf": [l.text for l in stellen[b.case_id, b.line][0].text_lines[:4]]}
                                 for b in a.belege]} for i, a in enumerate(antwort.aussagen)]
            ergebnis = await llm.ask(config.MODEL_CHAT, SYSTEM_FRAGE, pruef_prompt(frage, daten), AntwortPruefung, max_tokens=8000, effort=config.FRAGE_EFFORT)
            gueltig = [p for p in ergebnis.pruefungen if 0 <= p.index < len(antwort.aussagen)]
            for p in gueltig:
                antwort.aussagen[p.index].urteil = p.urteil
                antwort.aussagen[p.index].grund = p.grund
            senden(pruefung=[p.model_dump() for p in gueltig])
            gelungen = True
        except Exception as e:
            senden(pruefung=None, pruef_fehler=str(e)[:200])
    if gelungen:
        cache = _lesen(path)
        cache[schluessel] = {"antwort": antwort.model_dump(), "dateien": files, "hinweise": hints, "kontext": info}
        path.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
    return antwort
