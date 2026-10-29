"""CLI: python -m app.cli ingest <ordner>"""
import argparse
from pathlib import Path

from .ingest import assign_blatt, ingest


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["ingest", "process", "review", "board", "pool", "sammelakte"])
    ap.add_argument("folder", nargs="?")
    ap.add_argument("--case", default="fall")
    ap.add_argument("--name")
    args = ap.parse_args()
    if args.cmd == "sammelakte":
        import asyncio

        from . import sammelakte, store

        if not args.folder:
            ap.error("Massenverfahren-ID für sammelakte erforderlich")
        case_id = asyncio.run(sammelakte.create(args.folder))
        print(store.case_dir(case_id) / "case.json")
        return
    if args.cmd == "pool":
        import asyncio

        from . import pool

        asyncio.run(pool.refresh())
        sicht = pool.pool_view()
        for g in sicht["massenverfahren"]:
            print(f"{g['id']}  {g['sache']}")
            for m in g["mitglieder"]:
                datum = m["klageeingang"] or {}
                print(f"  {m['case_id']}  {m['name']}  {datum.get('anzeige') or 'Eingang unbekannt'}"
                      + (f" – {datum['hinweis']}" if datum.get("hinweis") else ""))
        print("Einzelakten:")
        for c in sicht["einzel"]:
            print(f"  {c['id']}  {c['name']}")
        return
    if args.cmd == "board":
        import asyncio

        from . import board, review, store, view

        case = store.load_case(args.case)
        if case is None:
            ap.error("Fall nicht gefunden")
        view.apply(case, review.load(case.id))
        struktur = asyncio.run(board.build_board(case))
        print(struktur.model_dump_json(indent=2))
        return
    if args.cmd == "review":
        import asyncio
        from collections import Counter

        from . import store
        from .review import art_beziehung, art_widerspruch, review

        case = store.load_case(args.case)
        if case is None:
            ap.error("Fall nicht gefunden")
        rv = asyncio.run(review(case))
        for feld, art in (("beziehungen", art_beziehung), ("widersprueche", art_widerspruch)):
            counts = Counter(art(rv, item) for item in getattr(case, feld))
            print(f"{feld}: " + ", ".join(f"{a or 'ungeprüft'}: {n}" for a, n in counts.items()))
        return
    if not args.folder:
        ap.error("Ordner für ingest/process erforderlich")
    if args.cmd == "process":
        import asyncio

        from .agent import run

        asyncio.run(run(Path(args.folder), args.case, args.name))
        return
    docs, sammel, n = ingest(Path(args.folder), set())
    assign_blatt(docs)
    for p in sammel:
        print(f"Sammelakte (wird beim Verarbeiten gegliedert): {p.name}")
    for d in docs:
        print(f"{d.id} {d.format:10} Bl.{d.blatt_von}-{d.blatt_bis} {d.doc_type:24} lines={len(d.text_lines):3} vision={d.needs_vision} {d.title}")
    print(f"{len(docs)} Aktenstücke aus {n} Dateien")


if __name__ == "__main__":
    main()
