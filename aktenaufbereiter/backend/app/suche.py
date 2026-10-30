"""Lokaler Volltextindex der Aktenzeilen."""
import hashlib
import logging
import re
import sqlite3
from contextlib import closing

from . import config, store
from .schemas import Case

STOPPWOERTER = set("wann wie was warum wer wo welche welcher welches der die das und oder ist war sind waren hat haben ein eine einer zum zur von vom mit für auf aus bei nach über dem den des sich auch wurde wurden gibt steht akte akten".split())


def _verbindung():
    config.CASES_DIR.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(config.CASES_DIR / "suche.sqlite")
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("CREATE VIRTUAL TABLE IF NOT EXISTS zeilen USING fts5(text, case_id UNINDEXED, doc_id UNINDEXED, anchor UNINDEXED, sammel UNINDEXED, tokenize='trigram')")
    db.execute("CREATE TABLE IF NOT EXISTS stand(case_id PRIMARY KEY, hash)")
    return db


def sync(case_id: str | None = None):
    pfade = [store.case_dir(case_id) / "case.json"] if case_id is not None else sorted(config.CASES_DIR.glob("*/case.json"))
    with closing(_verbindung()) as db, db:
        for row in db.execute("SELECT case_id FROM stand").fetchall():
            if not (store.case_dir(row["case_id"]) / "case.json").exists():
                db.execute("DELETE FROM zeilen WHERE case_id = ?", (row["case_id"],))
                db.execute("DELETE FROM stand WHERE case_id = ?", (row["case_id"],))
        for p in pfade:
            try:
                raw = p.read_bytes()
                digest = hashlib.sha256(raw).hexdigest()
                cid = p.parent.name
                stand = db.execute("SELECT hash FROM stand WHERE case_id = ?", (cid,)).fetchone()
                if stand and stand["hash"] == digest:
                    continue
                case = Case.model_validate_json(raw)
                zeilen = [(l.text, cid, d.id, l.anchor, int(case.massenverfahren is not None))
                          for d in case.dokumente for l in d.text_lines]
            except Exception:
                logging.getLogger(__name__).exception("Suchindex: Akte %s übersprungen", p.parent.name)
                continue
            db.execute("DELETE FROM zeilen WHERE case_id = ?", (cid,))
            db.executemany("INSERT INTO zeilen VALUES (?, ?, ?, ?, ?)", zeilen)
            db.execute("INSERT OR REPLACE INTO stand VALUES (?, ?)", (cid, digest))


def begriffe(frage: str) -> list[str]:
    return list(dict.fromkeys(w for w in re.findall(r"\w+", frage.lower()) if len(w) >= 3 and w not in STOPPWOERTER))


def suchen(terme: list[str], case_id: str | None, limit=20) -> list[dict]:
    terme = [t.replace('"', '') for t in terme]
    query = " OR ".join(f'"{t}"' for t in terme if len(t.strip()) >= 3)
    if not query:
        return []
    where, params = ("case_id = ?", [case_id]) if case_id is not None else ("sammel = 0", [])
    with closing(_verbindung()) as db:
        return [dict(r) for r in db.execute(
            f"SELECT case_id, doc_id, anchor, text FROM zeilen WHERE zeilen MATCH ? AND {where} ORDER BY bm25(zeilen) LIMIT ?",
            [query, *params, limit])]
