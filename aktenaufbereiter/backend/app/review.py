"""Klassifikation als separater, an den Akteninhalt gebundener Cache."""
import hashlib
import json

from . import config, llm, store
from .prompts import SYSTEM, review_prompt
from .schemas import Review


def _hash(obj) -> str:
    return hashlib.sha1(json.dumps(obj.model_dump(), sort_keys=True).encode()).hexdigest()


def load(case_id: str) -> dict:
    rv = store._json_file(case_id, "review.json")
    return {"beziehungen": rv.get("beziehungen", {}), "widersprueche": rv.get("widersprueche", {})}


async def review(case, progress=print) -> dict:
    rv = load(case.id)
    felder = ("beziehungen", "widersprueche")
    if all(rv[feld].get(obj.id, {}).get("hash") == _hash(obj)
           for feld in felder for obj in getattr(case, feld)):
        return rv
    progress("Prüfe Beziehungen und Widersprüche")
    result = await llm.ask(config.MODEL_CONSOLIDATE, SYSTEM, review_prompt(case), Review, max_tokens=8000)
    for feld in felder:  # unbekannte IDs ignorieren; fehlende bleiben ungeprüft (Heuristik greift)
        hashes = {obj.id: _hash(obj) for obj in getattr(case, feld)}
        rv[feld].update({obj.id: {"art": obj.art, "hash": hashes[obj.id]} for obj in getattr(result, feld) if obj.id in hashes})
    store._write_json(case.id, "review.json", rv)
    return rv


def art_beziehung(rv, r) -> str | None:
    item = rv.get("beziehungen", {}).get(r.id, {})
    return item.get("art") if item.get("hash") == _hash(r) else None


def art_widerspruch(rv, w) -> str | None:
    item = rv.get("widersprueche", {}).get(w.id, {})
    return item.get("art") if item.get("hash") == _hash(w) else None
