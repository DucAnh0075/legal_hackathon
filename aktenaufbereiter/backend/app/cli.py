"""CLI: python -m app.cli ingest <ordner>"""
import argparse
from pathlib import Path

from .ingest import assign_blatt, ingest


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["ingest", "process"])
    ap.add_argument("folder")
    ap.add_argument("--case", default="fall")
    ap.add_argument("--name")
    args = ap.parse_args()
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
