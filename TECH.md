# Tech-Stack des Aktenaufbereiters

Der Aktenaufbereiter besteht aus einem Python-Backend mit KI-Agent und einer React-Web-App. Die Modelle laufen über OpenRouter, die Ergebnisse liegen als JSON-Dateien auf der Platte. Eine Datenbank gibt es nicht.

```text
Browser (React, Vite)
   │  REST und Server-Sent Events über /api
   ▼
FastAPI-Backend ──► OpenRouter (DeepSeek, Text und Bilder)
   │
   ├─► Poppler und RapidOCR (PDF-Text, Seitenbilder, Texterkennung)
   └─► cases/<id>/ (JSON, Originaldateien, Cache)
```

## Backend

Python 3.12 in einem venv unter `aktenaufbereiter/backend/.venv`.

| Technik | Version | Aufgabe |
|---|---|---|
| FastAPI | 0.115.6 | REST-API, Datei-Upload, Fortschritt per Server-Sent Events |
| Uvicorn | 0.34.0 | ASGI-Server |
| Pydantic | 2.14 | Datenmodell und Prüfung der Modellantworten |
| OpenAI SDK | 3.41 | Client für die OpenAI-kompatible OpenRouter-API |
| json-repair | 0.64 | Repariert fehlerhaftes JSON aus Modellantworten |
| pypdf | 6.21 | Markiert Fundstellen als Highlight im Original-PDF |
| Poppler (`pdftotext`, `pdftoppm`, `pdfinfo`) | Systempaket `poppler-utils` | PDF-Text, Zeilenkästen, Seitenbilder, Seitenzahlen |
| RapidOCR mit ONNX Runtime | 3.10 / 1.31 | Texterkennung für Zeilenkästen in Scans |
| openpyxl | 3.1 | Excel-Export |
| python-dotenv | 1.2 | Lädt die Konfiguration aus `backend/.env` |
| python-multipart | 0.0.32 | Formular- und Datei-Uploads in FastAPI |

Die Versionen sind die im venv installierten. `backend/requirements.txt` legt nur FastAPI und Uvicorn exakt fest, die übrigen Pakete haben Mindestversionen.

### Module in `backend/app/`

| Modul | Aufgabe |
|---|---|
| `main.py` | API-Endpunkte und Job-Fortschritt |
| `cli.py` | Kommandozeile (`process`, `ingest`, `pool`, `sammelakte`) |
| `ingest.py` | Dateien erkennen, Text und Zeilenanker, Blattzahlen |
| `segment.py` | Mehrseitige Sammel-PDF in Aktenstücke gliedern |
| `agent.py` | Pipeline von der Extraktion bis zur fertigen `case.json` |
| `llm.py` | OpenRouter-Client mit JSON-Schema, Bildern und Wiederholungen |
| `prompts.py`, `schemas.py` | Prompts und Pydantic-Datenmodell |
| `validate.py` | Prüft Zeilenanker gegen die echten Zeilen |
| `marks.py` | Zeilenkästen im Original, Fundstellen markieren |
| `pool.py`, `sammelakte.py` | Massenverfahren erkennen, Sammelakte erstellen |
| `board.py`, `tables.py`, `view.py` | Beweisboard, Vorlagentabellen, Ansichten |
| `review.py`, `store.py` | Anmerkungen und Dateiablage |
| `export_xlsx.py` | Excel-Export |

## KI

| Punkt | Umsetzung |
|---|---|
| Anbieter | OpenRouter (`https://openrouter.ai/api/v1`) |
| Standardmodell | `deepseek/deepseek-v4.1-flash` für Extraktion und Konsolidierung, per `.env` änderbar |
| Eingaben | Text und Seitenbilder (Vision) |
| Ausgabe | JSON, geprüft gegen Pydantic-Schemas, `temperature=0` |
| Parallelität | Standardmäßig 5 gleichzeitige Aufrufe (`CONCURRENCY`) |
| Robustheit | Wiederholungen mit wachsender Wartezeit, JSON-Reparatur, Konsolidierung in Teilen |
| Cache | Extraktionen je Dokument unter `cases/<id>/extraktionen/` |

Anthropic-Modelle sind im OpenRouter-Workspace per Guardrail gesperrt.

## Frontend

| Technik | Version | Aufgabe |
|---|---|---|
| React | 19.3 | Oberfläche |
| TypeScript | 7.0 | Typisierung |
| Vite | 8.3 | Dev-Server und Build, Proxy von `/api` auf `:8000` |
| `@xyflow/react` | 12.12 | Beweisboard als Pinnwand mit Karten und Fäden |
| Oxlint | 1.89 | Linting |

Das Frontend ist einfaches CSS mit Design-Tokens in `oklch` für den hellen und dunklen Modus. Eine UI-Bibliothek gibt es nicht. Die Schriften Source Serif 4, IBM Plex Sans und IBM Plex Mono kommen von Google Fonts.

Der Fortschritt läuft über `EventSource`, der Klappzustand liegt in `localStorage`.

`@tanstack/react-table`, `d3-force`, `d3-scale`, `d3-time` und `react-markdown` stehen in der `package.json`, werden im Code aber nicht importiert.

## Datenablage

Alles liegt unter `aktenaufbereiter/cases/` und ist per `.gitignore` vom Repository ausgeschlossen.

| Datei oder Ordner | Inhalt |
|---|---|
| `<id>/case.json` | Fertig aufbereitete Akte |
| `<id>/akte/` | Aktenbestandteile |
| `<id>/extraktionen/` | Cache der Modellantworten |
| `<id>/annotations.json` | Anmerkungen |
| `<id>/profil.json` | Fallprofil für die Erkennung von Massenverfahren |
| `massenverfahren.json` | Gruppen im Aktenpool |

## Entwicklung

| Werkzeug | Aufgabe |
|---|---|
| Node.js 20, npm | Frontend-Abhängigkeiten, `npm i` braucht `--legacy-peer-deps` |
| Claude Code | Entwicklung, Regeln in `CLAUDE.md` |
| Codex CLI (`gpt-6-astra`) | Builder im Orchestrator-Modus, Regeln in `AGENTS.md` |
| Impeccable | Design-Skill und Detektor für das Frontend |

Das Repository enthält keine automatisierten Tests. Geprüft wird über den Typecheck `npx tsc -b`, die Ankerprüfung in `validate.py` und die Testakten unter `aktenaufbereiter/testdaten/massenverfahren/`.

## Voraussetzungen

- Python 3.12
- Node.js und npm
- `poppler-utils` als Systempaket
- OpenRouter-API-Key in `aktenaufbereiter/backend/.env`
