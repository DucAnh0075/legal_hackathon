"""Gefilterte Sicht; der gespeicherte Fall bleibt unverändert."""
import re

from .review import art_beziehung, art_widerspruch
from .validate import drop_trivial


def apply(case, rv: dict) -> None:
    drop_trivial(case)
    case.widersprueche = [w for w in case.widersprueche if art_widerspruch(rv, w) != "schreibweise"]
    personen = {p.id: p for p in case.personen}
    entitaeten = {e.id: e for e in case.entitaeten}
    richter = {p.id for p in case.personen if any(re.search("richter", r, re.I) for r in p.rollen)}

    def ende(id: str) -> bool:
        if id in entitaeten:
            return entitaeten[id].typ == "firma"
        if id in personen:
            return True
        return bool(id.strip()) and not re.search(
            r"^[pe]\d+$|gruppe|objekt|konto|profil|website|webseite|https?://|www\.|dokument|"
            r"fahrzeug|\bchip\b|rechnung|buchung|\bort\b|reisegesellschaft", id, re.I)

    def behalten(r) -> bool:
        if not ende(r.von) or not ende(r.zu) or r.von in richter or r.zu in richter:
            return False
        art = art_beziehung(rv, r)
        if art is not None:
            return art == "verhaeltnis"
        return not re.search(
            r"gegen|überweist|schickt|geschickt|erwischt|vernehmung|aufnahme|zustell|adressat|"
            r"kommuni|chat|telefonat|buchung|empfänger|stellt|bereit|verfasser|unterzeichner|"
            r"absender|nutzt|richter|im verfahren|reisegruppe|namensähnlich", r.beziehung, re.I)

    case.beziehungen = [r for r in case.beziehungen if behalten(r)]
