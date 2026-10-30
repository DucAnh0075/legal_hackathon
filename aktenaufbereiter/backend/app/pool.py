"""Aktenprofile und sachlicher Abgleich des Aktenpools."""
from __future__ import annotations

import asyncio
import hashlib
import json
import re

from . import config, llm, store
from .prompts import SYSTEM_POOL, pool_prompt, profil_prompt
from .schemas import Case, FallProfil, Fundstelle, PoolGruppen
from .validate import blatt_label


def _lesen(path) -> dict:
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


def _schreiben(path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def _fundstelle(case: Case, f: Fundstelle | None) -> Fundstelle | None:
    if f is None:
        return None
    doc = next((d for d in case.dokumente if d.id == f.doc_id), None)
    line = next((l for l in doc.text_lines if l.anchor == f.line), None) if doc else None
    if line is None:
        return None
    return f.model_copy(update={"blatt": blatt_label(doc, line), "unklar": False})


def _eingang(case: Case, p: FallProfil) -> None:
    if p.klageeingang and p.klageeingang.iso:
        return
    kandidaten = [(e.eingangsdatum, e.fundstellen[0] if e.fundstellen else None)
                  for e in case.ereignisse if e.kind == "verfahren"
                  and re.search(r"klage|anzeige|antrag|mahn", e.verfahrens_typ or "", re.I)
                  and e.eingangsdatum and e.eingangsdatum.iso]
    ersatz = False
    for feld in ("eingangsdatum", "dokumentdatum"):
        if kandidaten:
            break
        ersatz = feld == "dokumentdatum"
        kandidaten = [(getattr(d, feld), Fundstelle(doc_id=d.id, line=d.text_lines[0].anchor)
                       if d.text_lines else None) for d in case.dokumente
                      if getattr(d, feld) and getattr(d, feld).iso]
    if kandidaten:
        datum, fundstelle = min(kandidaten, key=lambda k: k[0].iso)
        p.klageeingang = datum.model_copy(deep=True)
        if ersatz:
            p.klageeingang.hinweis = "Eingang nicht ausgewiesen – Dokumentdatum"
        p.klageeingang_fundstelle = fundstelle


async def profil(case: Case) -> FallProfil:
    if case.massenverfahren is not None:
        raise ValueError("Sammelakten werden nicht profiliert")
    ordner = store.case_dir(case.id)
    digest = hashlib.sha256((ordner / "case.json").read_bytes()).hexdigest()
    cache = _lesen(ordner / "profil.json")
    if cache.get("hash") == digest:
        return FallProfil.model_validate(cache["profil"])
    p = await llm.ask(config.MODEL_CONSOLIDATE, SYSTEM_POOL, profil_prompt(case), FallProfil, max_tokens=4000)
    for m in p.merkmale:
        m.fundstellen = [f for quelle in m.fundstellen if (f := _fundstelle(case, quelle)) is not None]
    p.klageeingang_fundstelle = _fundstelle(case, p.klageeingang_fundstelle)
    if p.klageeingang_fundstelle is None:  # Eingang ohne belegbare Fundstelle nicht übernehmen
        p.klageeingang = None
    _eingang(case, p)
    _schreiben(ordner / "profil.json", {"hash": digest, "profil": p.model_dump()})
    return p


async def gruppen(profile: dict[str, FallProfil], namen: dict[str, str]) -> list[dict]:
    profile = {cid: p for cid, p in profile.items()
               if (case := store.load_case(cid)) is None or case.massenverfahren is None}
    eingabe = [{"case_id": cid, "name": namen.get(cid, cid),
                **p.model_dump(include={"verfahrensart", "aktivseite", "gegenseite", "gegenstand"}),
                "merkmale": [m.model_dump(include={"art", "wert"}) for m in p.merkmale]}
               for cid, p in sorted(profile.items())]
    prompt = pool_prompt(json.dumps(eingabe, ensure_ascii=False, separators=(",", ":")))
    # der Prompt gehört zum Hash, damit eine geänderte Regel neu gruppiert
    data = {cid: p.model_dump() for cid, p in sorted(profile.items())}
    digest = hashlib.sha256((json.dumps(data, ensure_ascii=False, sort_keys=True) + prompt).encode()).hexdigest()
    path = config.CASES_DIR / "massenverfahren.json"
    cache = _lesen(path)
    if cache.get("hash") == digest:
        return cache["gruppen"]
    out = await llm.ask(config.MODEL_CONSOLIDATE, SYSTEM_POOL, prompt,
                        PoolGruppen, max_tokens=4000) if len(profile) >= 2 else PoolGruppen()
    bisher = {cid: g["id"] for g in cache.get("gruppen", []) for cid in g["mitglieder"]}
    ergebnis, vergeben = [], set()
    for g in out.gruppen:
        ids = [cid for cid in dict.fromkeys(g.mitglieder) if cid in profile and cid not in vergeben]
        vergeben.update(ids)
        if len(ids) < 2:
            continue
        ids.sort(key=lambda cid: (not bool(profile[cid].klageeingang and profile[cid].klageeingang.iso),
                                 (profile[cid].klageeingang.iso or "") if profile[cid].klageeingang else "", cid))
        # bestehende Gruppen-ID behalten, damit die Sammelakte zugeordnet bleibt
        mv_id = next((bisher[cid] for cid in ids if cid in bisher), f"mv-{ids[0]}")
        if any(e["id"] == mv_id for e in ergebnis):
            mv_id = f"mv-{ids[0]}"
        ergebnis.append({"id": mv_id, "sache": g.sache,
                         "gemeinsamkeiten": g.gemeinsamkeiten, "mitglieder": ids})
    _schreiben(path, {"hash": digest, "gruppen": ergebnis})
    return ergebnis


async def refresh(progress=print) -> list[dict]:
    progress("prüft Aktenpool")
    sem = asyncio.Semaphore(config.CONCURRENCY)
    profile, namen = {}, {}

    async def pruefen(path):
        async with sem:
            try:
                case = Case.model_validate_json(path.read_text(encoding="utf-8"))
                if case.massenverfahren is not None:
                    return
                progress(f"Profil {case.id}")
                profile[case.id] = await profil(case)
                namen[case.id] = case.name
            except Exception as e:
                progress(f"Profil {path.parent.name} übersprungen: {e}")

    await asyncio.gather(*(pruefen(p) for p in sorted(config.CASES_DIR.glob("*/case.json"))))
    out = await gruppen(profile, namen)
    progress(f"{len(out)} Massenverfahren erkannt")
    return out


def load() -> list[dict]:
    return _lesen(config.CASES_DIR / "massenverfahren.json").get("gruppen", [])


def sammel_id(mv_id: str) -> str:
    return "sammel-" + mv_id.removeprefix("mv-")


def pool_view() -> dict:
    gruppiert = load()
    zugeordnet = {cid for g in gruppiert for cid in g["mitglieder"]}
    einzel = [c for c in store.list_cases() if c["id"] not in zugeordnet and not c["sammelakte"]]
    out = []
    for g in gruppiert:
        mitglieder = []
        for cid in g["mitglieder"]:
            case = store.load_case(cid)
            if case is None or case.massenverfahren is not None:
                continue
            p = FallProfil.model_validate(_lesen(store.case_dir(cid) / "profil.json").get("profil", {}))
            mitglieder.append({"case_id": cid, "name": case.name,
                               **p.model_dump(include={"klageeingang", "klageeingang_fundstelle",
                                                       "aktivseite", "gegenseite", "merkmale"})})
        sid = sammel_id(g["id"])
        sammel = store.load_case(sid)
        bestand = {v.case_id for v in sammel.massenverfahren.verfahren} if sammel and sammel.massenverfahren else set()
        out.append({**g, "mitglieder": mitglieder, "sammelakte_id": sid if sammel else None,
                    "neue_mitglieder": [m["case_id"] for m in mitglieder if m["case_id"] not in bestand]
                    if sammel else []})
    return {"einzel": einzel, "massenverfahren": out}
