from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

from . import config
from .schemas import Case, Document


def case_dir(case_id: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9_-]+", case_id):
        raise ValueError("ungültige Fall-ID")
    return config.CASES_DIR / case_id


def delete_case(case_id: str) -> None:
    shutil.rmtree(case_dir(case_id))


def save_case(case: Case) -> None:
    d = case_dir(case.id)
    d.mkdir(parents=True, exist_ok=True)
    (d / "case.json").write_text(case.model_dump_json(indent=2), encoding="utf-8")


def load_case(case_id: str) -> Case | None:
    p = case_dir(case_id) / "case.json"
    return Case.model_validate_json(p.read_text(encoding="utf-8")) if p.exists() else None


def list_cases() -> list[dict]:
    from . import review, view

    out = []
    for p in sorted(config.CASES_DIR.glob("*/case.json")):
        c = Case.model_validate_json(p.read_text(encoding="utf-8"))
        view.apply(c, review.load(c.id))
        out.append({"id": c.id, "name": c.name, "dokumente": len(c.dokumente), "personen": len(c.personen),
                    "widersprueche": len(c.widersprueche), "sammelakte": c.massenverfahren is not None})
    return out


def _json_file(case_id: str, name: str) -> dict:
    p = case_dir(case_id) / name
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}


def _write_json(case_id: str, name: str, data: dict) -> None:
    d = case_dir(case_id)
    d.mkdir(parents=True, exist_ok=True)
    (d / name).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def get_annotations(case_id: str) -> dict:
    return _json_file(case_id, "annotations.json")


def set_annotation(case_id: str, row_id: str, field: str, value: str) -> dict:
    a = get_annotations(case_id)
    a.setdefault(row_id, {"kanzlei": "offen", "mandant": "offen"})[field] = value
    _write_json(case_id, "annotations.json", a)
    return a[row_id]


def get_layout(case_id: str) -> dict:
    return _json_file(case_id, "board_layout.json")


def set_layout(case_id: str, layout: dict) -> None:
    _write_json(case_id, "board_layout.json", layout)


def sort_files(case_id: str, docs: list[Document]) -> None:
    """Kopiert die Originale sortiert: akte/<Blatt>_<ID>_<Typ>.<ext>"""
    out = case_dir(case_id) / "akte"
    out.mkdir(parents=True, exist_ok=True)
    for d in docs:
        slug = re.sub(r"[^A-Za-z0-9]+", "-", d.doc_type or "akte").strip("-")
        for r in d.representations:
            src = Path(r.path)
            dst = out / f"{d.blatt_von:03d}_{d.id}_{slug}_{r.format}{src.suffix.lower()}"
            shutil.copy2(src, dst)
            r.sorted_path = str(dst.relative_to(case_dir(case_id)))
        main = next(r for r in d.representations if r.format == d.format)
        d.sorted_path = main.sorted_path


def get_suspects(case_id: str) -> dict[str, bool]:
    return _json_file(case_id, "suspects.json")


def set_suspects(case_id: str, suspects: dict[str, bool]) -> None:
    _write_json(case_id, "suspects.json", suspects)
