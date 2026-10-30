from __future__ import annotations

import asyncio
import json
import logging
import shutil
import uuid
from pathlib import Path
from typing import Awaitable, Callable

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, StreamingResponse
from pydantic import BaseModel

from . import board, frage, pool, review, sammelakte, store, suche, view
from .agent import Progress, run
from .export_xlsx import export
from .tables import build
from .marks import find_marks, marked_pdf

app = FastAPI(title="Aktenaufbereiter")
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173"], allow_methods=["*"], allow_headers=["*"])
jobs: dict[str, asyncio.Queue] = {}


def _case(case_id: str):
    c = store.load_case(case_id)
    if not c:
        raise HTTPException(404, "Fall nicht gefunden")
    view.apply(c, review.load(case_id))
    return c


async def _job(job: str, work: Callable[[Progress], Awaitable]) -> None:
    q = jobs[job]
    try:
        await work(lambda m: q.put_nowait(m if isinstance(m, dict) else {"msg": m}))
        q.put_nowait({"done": True})
    except Exception as e:  # noqa: BLE001
        q.put_nowait({"error": str(e)})


async def _start(work: Callable[[Progress], Awaitable]) -> str:
    job = uuid.uuid4().hex
    jobs[job] = asyncio.Queue()
    asyncio.create_task(_job(job, work))
    return job


@app.get("/api/pool")
def get_pool():
    return pool.pool_view()


@app.post("/api/pool/refresh")
async def refresh_pool():
    return {"job": await _start(pool.refresh)}


@app.post("/api/pool/{mv_id}/sammelakte")
async def create_sammelakte(mv_id: str):
    if not any(g["id"] == mv_id for g in pool.load()):
        raise HTTPException(404, "Massenverfahren nicht gefunden")
    job = await _start(lambda progress: sammelakte.create(mv_id, progress))
    return {"job": job, "case_id": pool.sammel_id(mv_id)}


@app.post("/api/cases")
async def create_case(case_id: str = Form(...), name: str | None = Form(None), folder: str | None = Form(None),
                      files: list[UploadFile] = File(default=[])):
    store.case_dir(case_id)
    if folder:
        src = Path(folder).expanduser()
        if not src.is_dir():
            raise HTTPException(400, "Ordner nicht gefunden")
    else:
        src = Path("/tmp") / f"upload_{uuid.uuid4().hex}"
        src.mkdir()
        for f in files:
            (src / Path(f.filename or "x").name).write_bytes(await f.read())
    async def verarbeiten(progress: Progress):
        await run(src, case_id, name, progress=progress)
        try:
            await pool.refresh(progress)
        except Exception as e:
            progress(f"Pool-Prüfung fehlgeschlagen: {e}")

    return {"job": await _start(verarbeiten)}


@app.get("/api/jobs/{job}/events")
async def events(job: str):
    q = jobs.get(job)
    if q is None:
        raise HTTPException(404)

    async def gen():
        while True:
            ev = await q.get()
            yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
            if ev.get("done") or ev.get("error"):
                jobs.pop(job, None)
                return

    return StreamingResponse(gen(), media_type="text/event-stream")


@app.get("/api/cases")
def cases():
    return store.list_cases()


@app.get("/api/cases/{case_id}")
def get_case(case_id: str):
    c = _case(case_id)
    return {"case": c, "tables": build(c, store.get_annotations(case_id)), "layout": store.get_layout(case_id),
            "suspects": store.get_suspects(case_id), "board": board.load(c)}


@app.get("/api/cases/{case_id}/files/{doc_id}")
def get_file(case_id: str, doc_id: str, fmt: str | None = None, mark: str | None = None):
    c = _case(case_id)
    d = next((d for d in c.dokumente if d.id == doc_id), None)
    if not d:
        raise HTTPException(404)
    rep = next((r for r in d.representations if r.format == fmt), None) if fmt else None
    if fmt and rep is None:
        raise HTTPException(404, "Dateiformat nicht gefunden")
    rel = rep.sorted_path if rep else d.sorted_path
    if not rel:
        raise HTTPException(404, "Datei nicht gefunden")
    path = store.case_dir(case_id) / rel
    selected = rep.format if rep else d.format
    if mark and selected in ("pdf_text", "pdf_image"):
        marks = find_marks(case_id, d, selected, mark.split(","))
        return Response(marked_pdf(path, marks["boxes"]), media_type="application/pdf")
    return FileResponse(path)


@app.get("/api/cases/{case_id}/marks/{doc_id}")
def get_marks(case_id: str, doc_id: str, lines: str, fmt: str | None = None):
    c = _case(case_id)
    d = next((d for d in c.dokumente if d.id == doc_id), None)
    if not d or (fmt and not any(r.format == fmt for r in d.representations)):
        raise HTTPException(404)
    return find_marks(case_id, d, fmt, lines.split(","))


@app.put("/api/cases/{case_id}/suspects")
def put_suspects(case_id: str, body: dict[str, bool]):
    _case(case_id)
    store.set_suspects(case_id, body)
    return {"ok": True}


class AnnIn(BaseModel):
    field: str
    value: str


@app.put("/api/cases/{case_id}/annotations/{row_id}")
def put_annotation(case_id: str, row_id: str, body: AnnIn):
    if body.field not in ("kanzlei", "mandant"):
        raise HTTPException(400)
    _case(case_id)
    return store.set_annotation(case_id, row_id, body.field, body.value)


@app.put("/api/cases/{case_id}/board-layout")
def put_layout(case_id: str, layout: dict):
    _case(case_id)
    store.set_layout(case_id, layout)
    return {"ok": True}


@app.get("/api/cases/{case_id}/export.xlsx")
def export_xlsx(case_id: str):
    c = _case(case_id)
    return Response(export(c, store.get_annotations(case_id)),
                    media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": f'attachment; filename="{case_id}.xlsx"'})


@app.on_event("startup")
async def suchindex_starten():
    async def aufbauen():
        try:
            await asyncio.to_thread(suche.sync)
        except Exception:
            logging.getLogger(__name__).exception("Suchindex fehlgeschlagen")

    asyncio.create_task(aufbauen())


class FrageIn(BaseModel):
    frage: str
    case_id: str | None = None
    verlauf: list[dict] = []


@app.post("/api/fragen")
async def fragen(body: FrageIn):
    if not body.frage.strip() or len(body.frage) > 2000:
        raise HTTPException(400, "Frage muss 1 bis 2000 Zeichen enthalten")
    if body.case_id is not None:
        try:
            if store.load_case(body.case_id) is None:
                raise ValueError("Akte nicht gefunden")
        except (ValueError, OSError):
            raise HTTPException(404, "Akte nicht gefunden") from None
    return {"job": await _start(lambda progress: frage.beantworten(body.frage, body.case_id, body.verlauf, emit=progress))}
