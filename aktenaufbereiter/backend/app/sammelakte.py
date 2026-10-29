"""Einzelverfahren mit eigenen Dokumentpräfixen in einer Sammelakte bündeln."""
from __future__ import annotations

import asyncio
import json
import re

from . import agent, config, pool, store
from .schemas import DocExtraction, Document, Einzelverfahren, FallProfil, MassenverfahrenInfo


def _remap(obj, mapping):
    def walk(value):
        if isinstance(value, dict):
            return {k: mapping.get(v, v) if k == "doc_id" and isinstance(v, str) else walk(v)
                    for k, v in value.items()}
        if isinstance(value, list):
            return [walk(v) for v in value]
        if isinstance(value, str):
            match = re.fullmatch(r"([A-Z]\d{2})(:L\d+)", value)
            if match and match[1] in mapping:
                return mapping[match[1]] + match[2]
        return value

    data = walk(obj.model_dump())
    if isinstance(obj, Document):
        data["id"] = mapping.get(obj.id, obj.id)
        data["title"] = obj.title
    return type(obj).model_validate(data)


async def create(mv_id: str, progress=print) -> str:
    g = next((g for g in pool.load() if g["id"] == mv_id), None)
    if g is None:
        raise RuntimeError("Massenverfahren nicht gefunden")
    sid = pool.sammel_id(mv_id)
    existing = store.load_case(sid)
    verfahren = list(existing.massenverfahren.verfahren) if existing and existing.massenverfahren else []
    bekannt = {v.case_id for v in verfahren}
    mitglieder = [m for m in g["mitglieder"] if m not in bekannt]
    if existing and not mitglieder:
        raise RuntimeError("Sammelakte ist aktuell")
    start = max((ord(v.buchstabe) - ord("A") + 1 for v in verfahren), default=0)
    if start + len(mitglieder) > 26:
        raise RuntimeError("Eine Sammelakte kann höchstens 26 Verfahren (A–Z) enthalten")
    offset = max((d.blatt_bis or 0 for d in existing.dokumente), default=0) if existing else 0
    blatt_offset = offset
    docs, extractions = [], []
    cache = store.case_dir(sid) / "extraktionen"
    sem = asyncio.Semaphore(config.CONCURRENCY)
    for i, m in enumerate(mitglieder, start):
        buchstabe = chr(ord("A") + i)
        progress(f"übernimmt {m} als Verfahren {buchstabe}")
        source = store.load_case(m)
        if source is None:
            raise RuntimeError(f"Einzelakte {m} nicht gefunden")
        original = sorted(source.dokumente, key=lambda d: d.blatt_von or 0)
        if len(original) > 99:
            raise RuntimeError(f"Verfahren {m} enthält mehr als 99 Dokumente")
        mapping = {d.id: f"{buchstabe}{n:02d}" for n, d in enumerate(original, 1)}
        profil_data = json.loads((store.case_dir(m) / "profil.json").read_text(encoding="utf-8"))
        profil = _remap(FallProfil.model_validate(profil_data["profil"]), mapping)
        for old in original:
            if old.blatt_von is None or old.blatt_bis is None:
                raise RuntimeError(f"{m}/{old.id}: Blattnummern fehlen")
            doc = _remap(old, mapping)
            doc.quelle_akte = m
            doc.blatt_von = old.blatt_von + blatt_offset
            doc.blatt_bis = old.blatt_bis + blatt_offset
            doc.representations = [r.model_copy(update={
                "path": str(store.case_dir(m) / r.sorted_path), "sorted_path": None})
                for r in old.representations if r.sorted_path]
            doc.sorted_path = None
            path = store.case_dir(m) / "extraktionen" / f"{old.id}.json"
            cache.mkdir(parents=True, exist_ok=True)
            if path.exists():
                ex = _remap(DocExtraction.model_validate_json(path.read_text(encoding="utf-8")), mapping)
            else:
                ex = await agent._extract(doc.model_copy(deep=True, update={"needs_vision": False}),
                                          sem, progress, cache)
            (cache / f"{doc.id}.json").write_text(ex.model_dump_json(), encoding="utf-8")
            docs.append(doc)
            extractions.append(ex)
        blatt_offset += max((d.blatt_bis for d in original), default=0)
        verfahren.append(Einzelverfahren(
            buchstabe=buchstabe, case_id=m, name=source.name,
            **profil.model_dump(include={"aktivseite", "gegenseite", "klageeingang",
                                         "klageeingang_fundstelle", "merkmale"})))
    info = MassenverfahrenInfo(mv_id=mv_id, sache=g["sache"],
                              gemeinsamkeiten=g["gemeinsamkeiten"], verfahren=verfahren)
    await agent.finish(sid, name=existing.name if existing else f"Sammelakte – {g['sache']}",
                       docs=docs, extractions=extractions, existing=existing, offset=offset,
                       progress=progress, extra={"massenverfahren": info})
    return sid
