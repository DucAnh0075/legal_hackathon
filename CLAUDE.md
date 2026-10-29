# Aktenaufbereiter

KI-Agent + Web-App für den Strafrichter (Legal Hackathon, Challenge 5): liest Aktenbestandteile (Markdown, Text-PDF, Scan-PDF, Screenshots, mehrseitige Sammel-PDFs), sortiert sie und erzeugt Verzeichnisse, zwei Zeitleisten, Widersprüche und ein Beweisboard. Siehe [PRODUCT.md](PRODUCT.md) für Zielgruppe und Designprinzipien.

## Harte Regeln (gelten für Prompts und Ausgabe)
- Nur Akteninhalt, keine Wertung, keine rechtliche Bewertung, keine Erfolgsaussichten.
- Jede Angabe trägt eine Fundstelle (Zeilenanker `A06:L03` + Blatt). Anker werden in `validate.py` gegen die echten Zeilen geprüft; nie Anker erfinden.
- Widersprüche mit allen Varianten und Fundstellen dokumentieren; Unsicherheiten markieren ("Datum unklar", `[unleserlich]`).
- Normen (z. B. § 263 StGB) nur übernehmen, wenn sie in der Akte stehen.
- Ereignisdatum, Dokumentdatum, Eingangsdatum immer getrennt halten.
- Ergänzungsmodus ist append-only: bestehende Zeilen, IDs und Anmerkungen (Kanzlei/Mandant) nie ändern.

## Struktur
- `aktenaufbereiter/backend/` FastAPI + Agent (Python 3.12, venv in `.venv`)
  - `app/ingest.py` Dateien erkennen (ID im Dateinamen, sonst `D01`…), Text/Zeilenanker, Blattzahlen
  - `app/segment.py` mehrseitige Sammel-PDF seitenweise lesen und in Aktenstücke gliedern
  - `app/agent.py` Pipeline: Ingest → Extraktion je Dokument → `finish` (Konsolidierung in 4 Teilen → Validierung → `cases/<id>/case.json`)
  - `app/pool.py` Massenverfahren im Aktenpool: Fallprofil je Akte (`profil.json`) → Gruppierung (`cases/massenverfahren.json`, ID `mv-<früheste Akte>`)
  - `app/sammelakte.py` Sammelakte `sammel-<…>` aus einer Gruppe: Dokumente je Einzelverfahren als A01…, B01…, Extraktionen übernommen, dann `agent.finish`
  - `app/llm.py` OpenRouter-Client (JSON-Schema, Vision, Retry, `json_repair`)
  - `app/prompts.py`, `app/schemas.py` (Pydantic = Datenmodell), `app/tables.py` (Vorlagenspalten), `app/export_xlsx.py`, `app/main.py` (API + SSE)
- `aktenaufbereiter/frontend/` Vite + React + TS (`@xyflow/react` fürs Beweisboard); Dev-Proxy `/api` → `:8000`
- `aktenaufbereiter/cases/<id>/` Ergebnisse je Akte (gitignored): `case.json`, `akte/`, `extraktionen/` (Cache), `annotations.json`

## Befehle
```bash
cd aktenaufbereiter/backend
cp .env.example .env                                   # OPENROUTER_API_KEY eintragen
.venv/bin/uvicorn app.main:app --port 8000
.venv/bin/python -m app.cli process "<ordner>" --case <id> --name "<name>"
.venv/bin/python -m app.cli ingest "<ordner>"          # nur Einlesen, ohne Modell
.venv/bin/python -m app.cli pool                       # Massenverfahren im Pool erkennen
.venv/bin/python -m app.cli sammelakte mv-<id>         # Sammelakte erstellen/ergänzen
cd ../frontend && npm run dev                          # http://localhost:5173
npx tsc -b                                             # Typecheck
```
Backend nach Änderungen an `.env` oder Python-Code neu starten (kein Reload).

## Stolpersteine
- **Modelle:** Der OpenRouter-Workspace sperrt per Guardrail die Anthropic-Modelle. Erlaubt u. a. `deepseek/deepseek-v4.1-flash` (Standard, Vision + JSON). Erlaubte Modelle: `GET /api/v1/models/user` mit dem Key.
- **npm:** `npm i` stürzt mit npm 10.8 an der Peer-Auflösung ab → `--legacy-peer-deps`.
- **Cache:** `cases/<id>/extraktionen/` wird wiederverwendet; zum Neulesen eines Dokuments dessen JSON löschen.
- **Konsolidierung:** große JSON-Antworten scheitern; deshalb in Teilen (entities → events/statements/rest parallel).
- **Pool:** Profile sind an den `case.json`-Hash gebunden; zum Neuprofilieren `cases/<id>/profil.json` löschen. Die Gruppen-ID bleibt über `massenverfahren.json` stabil, deshalb diese Datei nicht löschen, wenn schon eine Sammelakte existiert. Testakten: `aktenaufbereiter/testdaten/massenverfahren/`.
- **Secrets:** `.env` nie committen oder ausgeben; Key nur in `backend/.env`.

## Design
Frontend-Arbeit mit den Skills `impeccable` (Operate-Modus) und `emil-design-eng`; Detektor: `.claude/skills/impeccable/scripts/impeccable detect --json aktenaufbereiter/frontend/src`. Beweisboard = Kork-Pinnwand mit Karten und roten Fäden; sonst ruhiges Kanzlei-Dossier, hell/dunkel.
