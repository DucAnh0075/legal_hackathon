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

## Massenverfahren
Nach jeder Verarbeitung gleicht `pool.py` alle Akten ab. Akten mit derselben Gegenseite und demselben Lebenssachverhalt (z. B. derselbe Flug, dasselbe zurückgerufene Produkt) erscheinen unter „Aktenpool → Massenverfahren in Sache X“, sortiert nach Eingang der Klage. Per Klick entsteht daraus eine Sammelakte mit allen Funktionen einer normalen Akte. Jedes Einzelverfahren bekommt einen eigenen Buchstaben als Dokumentpräfix. Die Einzelakten bleiben unverändert, die Sammelakte wird nur ergänzt.

## Hinweis
`cases/demo` ist ein von Hand gebauter UI-Testfall (ohne KI) und kann gelöscht werden.
