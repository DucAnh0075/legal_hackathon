from __future__ import annotations

import asyncio
import json
import shutil
import uuid
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, StreamingResponse
from pydantic import BaseModel

from . import review, store, view
from .agent import run
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


async def _job(job: str, folder: Path, case_id: str, name: str | None) -> None:
    q = jobs[job]
    try:
        await run(folder, case_id, name, progress=lambda m: q.put_nowait({"msg": m}))
        q.put_nowait({"done": True})
    except Exception as e:  # noqa: BLE001
        q.put_nowait({"error": str(e)})


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
    job = uuid.uuid4().hex
    jobs[job] = asyncio.Queue()
    asyncio.create_task(_job(job, src, case_id, name))
    return {"job": job}


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
            "suspects": store.get_suspects(case_id)}


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
