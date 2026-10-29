# Aktenaufbereiter

Liest Aktenbestandteile (Markdown, Text-PDF, Bild-PDF, Screenshots), sortiert sie, vergibt virtuelle Blattzahlen und erzeugt
Verzeichnisse, zwei Zeitleisten (Geschehen / Verfahren mit Ereignis-, Dokument- und Eingangsdatum), Widersprüche und ein Beweisboard.
Jede Angabe trägt eine Fundstelle (`A06:L03`, Blatt) und öffnet per Klick die Originaldatei.

## Start
```bash
cd backend
cp .env.example .env          # OPENROUTER_API_KEY eintragen
.venv/bin/uvicorn app.main:app --port 8000
# zweites Terminal
cd frontend && npm run dev     # http://localhost:5173
```
Ohne Oberfläche: `.venv/bin/python -m app.cli process "<ordner>" --case nordstern`

## Pipeline
Ingest (`ingest.py`) → Extraktion je Dokument, Vision für Bilder (`MODEL_EXTRACT`) → Konsolidierung (`MODEL_CONSOLIDATE`)
→ deterministische Prüfung aller Fundstellen (`validate.py`) → `cases/<id>/case.json`.
Wird eine bestehende Fall-Kennung erneut verwendet, bleiben vorhandene Zeilen und Anmerkungen unverändert (nur Ergänzung).

## Hinweis
`cases/demo` ist ein von Hand gebauter UI-Testfall (ohne KI) und kann gelöscht werden.
