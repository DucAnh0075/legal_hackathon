"""Beweisboard als separate Sicht; der Aktenbestand bleibt unverändert."""
import hashlib
import json
import re

from pydantic import ValidationError

from . import config, llm, store
from .prompts import SYSTEM, board_prompt
from .schemas import BoardBeweis, BoardRolle, BoardSeite, BoardStruktur
from .validate import blatt_label

VERFAHRENSDOKUMENT = re.compile(
    r"verfügung|beschluss|ladung|zustell|empfangsbekenntnis|terminsbestimmung|"
    r"geschäftsverteilung|zählblatt|pebb|kostenrechnung|vollmacht|aktendeckel|\bklage|erwiderung|replik|"
    r"duplik|schriftsatz|anklageschrift|haftbefehl|gesetz|formular|arbeitshilfe|urteil", re.I)
JUSTIZ = re.compile(r"richter|justizsekret|urkundsbeamt|geschäftsstelle|serviceeinheit|"
                    r"servicekraft|wachtmeister|amtsgericht|landgericht|oberlandesgericht|"
                    r"justizvollzug|sitzungssaal|vorführstelle", re.I)
VERTRETER = re.compile(r"prozessbevollm|rechtsanw|anwält|kanzlei|verteidig", re.I)


def _hash(case) -> str:
    data = {feld: [o.model_dump() for o in getattr(case, feld)]
            for feld in ("personen", "entitaeten", "beziehungen")}
    data["dokumente"] = [d.id for d in case.dokumente]
    return hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()


def _beteiligte(case):
    return {o.id: o for o in [*case.personen, *case.entitaeten]
            if not JUSTIZ.search(" ".join(o.rollen) if hasattr(o, "rollen") else o.label)}


def clean(case, struktur: BoardStruktur) -> BoardStruktur:
    struktur = struktur.model_copy(deep=True)
    zivil = struktur.verfahrensart == "zivil"  # einheitliche Spaltenköpfe statt Modelltext
    struktur.aktiv.bezeichnung = "Klägerseite" if zivil else "Anklage"
    struktur.passiv.bezeichnung = "Beklagtenseite" if zivil else "Angeklagte · Verteidigung"
    ids, gesehen = _beteiligte(case), set()

    def behalten(id):
        if id not in ids or id in gesehen:
            return False
        gesehen.add(id)
        return True

    for seite in (struktur.aktiv, struktur.passiv):
        seite.haupt = [id for id in seite.haupt if behalten(id)]
    for feld in ("vertreter", "zeugen"):
        for seite in (struktur.aktiv, struktur.passiv):
            setattr(seite, feld, [r for r in getattr(seite, feld) if behalten(r.id)])
    struktur.weitere = [r for r in struktur.weitere if behalten(r.id)]
    docs = {d.id: d for d in case.dokumente}
    anker = {d.id: {l.anchor: l for l in d.text_lines} for d in case.dokumente}
    beweise = {}
    for b in struktur.beweismittel:
        if b.person not in ids or (b.doc_id is not None and b.doc_id not in docs):
            continue
        if b.doc_id and VERFAHRENSDOKUMENT.search(f"{docs[b.doc_id].doc_type} {docs[b.doc_id].title}"):
            continue
        if b.doc_id is None and VERFAHRENSDOKUMENT.search(b.bezeichnung):
            continue
        fs = {}
        for f in b.fundstellen:
            d = docs.get(f.doc_id)
            if d is None or (f.line is not None and f.line not in anker[d.id]):
                continue
            f.blatt = blatt_label(d, anker[d.id].get(f.line))
            f.unklar = False
            fs[(f.doc_id, f.line)] = f
        b.fundstellen = list(fs.values())
        key = (b.person, b.doc_id, b.bezeichnung if b.doc_id is None else "")
        if key in beweise:
            alt = beweise[key]
            bekannt = {(f.doc_id, f.line) for f in alt.fundstellen}
            alt.fundstellen += [f for f in b.fundstellen if (f.doc_id, f.line) not in bekannt]
        else:
            beweise[key] = b
    # Ergänzung aus den Fundstellen: Aktenstücke, in denen eine Person (außer Vertretern) vorkommt
    vertreter = {r.id for seite in (struktur.aktiv, struktur.passiv) for r in seite.vertreter}
    personen = {p.id: p for p in case.personen}
    for pid in gesehen - vertreter:
        for f in personen[pid].fundstellen if pid in personen else []:
            d = docs.get(f.doc_id)
            if not d or VERFAHRENSDOKUMENT.search(f"{d.doc_type} {d.title}"):
                continue
            key = (pid, d.id, "")
            if key not in beweise:
                beweise[key] = BoardBeweis(person=pid, doc_id=d.id, bezeichnung=d.title or d.doc_type or d.id, fundstellen=[])
            if f.line and f.line in anker[d.id] and all(x.line != f.line for x in beweise[key].fundstellen):
                beweise[key].fundstellen.append(f.model_copy(update={"blatt": blatt_label(d, anker[d.id][f.line]), "unklar": False}))
    struktur.beweismittel = list(beweise.values())
    return struktur


def fallback(case) -> BoardStruktur:
    ids = _beteiligte(case)
    zivil = any(re.search(r"kläger|beklagt", r, re.I) for p in case.personen for r in p.rollen)
    board = BoardStruktur(verfahrensart="zivil" if zivil else "straf",
                         aktiv=BoardSeite(bezeichnung="Klägerseite" if zivil else "Anklageseite"),
                         passiv=BoardSeite(bezeichnung="Beklagtenseite" if zivil else "Angeklagte / Verteidigung"))
    for p in case.personen:
        if p.id not in ids:
            continue
        rollen = " / ".join(p.rollen)
        rolle = BoardRolle(id=p.id, rolle=rollen)
        if zivil:
            # „Rechtsanwalt der Klägerin“ ist keine Hauptpartei.
            if not VERTRETER.search(rollen) and not re.search(r"geschäftsführ", rollen, re.I):
                if re.search(r"kläger", rollen, re.I):
                    board.aktiv.haupt.append(p.id)
                elif re.search(r"beklagt", rollen, re.I):
                    board.passiv.haupt.append(p.id)
        else:
            if re.search(r"beschuldigt|angeklagt|angeschuldigt", rollen, re.I):
                board.passiv.haupt.append(p.id)
            if re.search(r"anzeig|geschädigt", rollen, re.I) and not re.search(r"aufnahme", rollen, re.I):
                board.aktiv.haupt.append(p.id)
            if re.search(r"verteidig", rollen, re.I):
                board.passiv.vertreter.append(rolle)
            if re.search(r"staatsanw", rollen, re.I):
                board.aktiv.vertreter.append(rolle)
            if re.search(r"zeug", rollen, re.I):
                board.aktiv.zeugen.append(rolle)
    if zivil:
        if not board.passiv.haupt:
            board.passiv.haupt = [r.zu for r in case.beziehungen if r.zu in ids and
                                 re.search(r"klägerin? gegen|(?:prozessbevollm|rechtsanw|anwält).*beklagten", r.beziehung, re.I)]
        for seite in (board.aktiv, board.passiv):
            seite.vertreter = [BoardRolle(id=r.von, rolle=r.beziehung) for r in case.beziehungen
                              if r.zu in seite.haupt and VERTRETER.search(r.beziehung)]
    else:
        board.aktiv.haupt += [e.id for e in case.entitaeten if re.search(r"staatsanwaltschaft", e.label, re.I)]
    board.weitere = [BoardRolle(id=id, rolle=" / ".join(o.rollen) if hasattr(o, "rollen") else o.typ)
                    for id, o in ids.items() if hasattr(o, "rollen") or o.typ in ("firma", "konto")]
    docs = {d.id: d for d in case.dokumente}
    for p in case.personen:
        for f in p.fundstellen:
            d = docs.get(f.doc_id)
            if d and not VERFAHRENSDOKUMENT.search(f"{d.doc_type} {d.title}"):
                board.beweismittel.append(BoardBeweis(person=p.id, doc_id=d.id,
                                                      bezeichnung=d.title or d.doc_type or d.id,
                                                      fundstellen=[f.model_copy(deep=True)]))
    return clean(case, board)


def _cached(case) -> BoardStruktur | None:
    try:
        cache = store._json_file(case.id, "board.json")
        if cache.get("hash") == _hash(case):
            return clean(case, BoardStruktur.model_validate(cache["struktur"]))
    except (OSError, ValueError, KeyError, TypeError, AttributeError, ValidationError):
        pass
    return None


def load(case) -> BoardStruktur:
    return _cached(case) or fallback(case)


async def build_board(case, progress=print) -> BoardStruktur:
    cached = _cached(case)
    if cached is not None:
        return cached
    progress("Ordne Beweisboard")
    result = await llm.ask(config.MODEL_CONSOLIDATE, SYSTEM, board_prompt(case), BoardStruktur, max_tokens=8000)
    struktur = clean(case, result)
    store._write_json(case.id, "board.json", {"hash": _hash(case), "struktur": struktur.model_dump()})
    return struktur
