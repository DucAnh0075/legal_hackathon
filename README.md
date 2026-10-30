# Aktenaufbereiter

KI-Agent und Web-App für die Vorbereitung der Hauptverhandlung, entstanden beim Legal Hackathon (Challenge 5: „Vom Aktenchaos zur klaren Struktur“).

Der Aktenaufbereiter liest gemischte Aktenbestandteile und ordnet sie. Jede Angabe führt per Klick zur Fundstelle im Original. Das Werkzeug gibt nur den Akteninhalt wieder und nimmt keine Wertung oder rechtliche Bewertung vor.

## Funktionen

- **Einlesen:** Markdown, Text-PDF, Scan-PDF, Screenshots und mehrseitige Sammel-PDFs, mit Zeilenankern (`A06:L03`) und virtuellen Blattzahlen
- **Übersichten:** Verzeichnisse, Personen, Tatkomplexe, Beziehungen und Fristen
- **Zwei Zeitleisten:** Geschehen und Verfahren, mit getrenntem Ereignis-, Dokument- und Eingangsdatum
- **Widersprüche:** alle Varianten mit ihren Fundstellen, ohne Bewertung
- **Beweisboard:** Pinnwand mit Karten und roten Fäden
- **Fragen an die Akte:** Antworten mit Belegen, die im Code gegen die Originalzeilen geprüft werden
- **Massenverfahren:** erkennt gleichartige Akten im Pool und fasst sie zu einer Sammelakte zusammen
- **Externe Daten:** neutraler Bericht zu Echtweltdaten auf Auswahl des Richters, getrennt von der Akte und als „Nicht Akteninhalt“ gekennzeichnet
- **Export:** Excel

## So arbeitet es

```text
Dateien → Ingest → Extraktion je Dokument → Konsolidierung → Ankerprüfung → case.json → Web-App
```

Das Modell liest und strukturiert, der Code prüft. `validate.py` gleicht alle Fundstellen mit den echten Zeilen ab, markiert ungültige als unklar und weist fehlende als Warnung aus.

Fragen laufen je nach Aktengröße unterschiedlich: Bis 60.000 Zeichen liest das Modell den ganzen Text. Darüber plant es Suchbegriffe, ein lokaler Volltextindex liefert die Treffer, und nur diese Stellen samt Nachbarzeilen gehen ans Modell.

## Tech-Stack

| Bereich | Technik |
|---|---|
| Backend | Python 3.12, FastAPI, Uvicorn, Pydantic |
| KI | OpenRouter über das OpenAI SDK, Standardmodell `deepseek/deepseek-v4.1-flash` (Text und Bilder), `json-repair` |
| Dokumente | Poppler (`pdftotext`, `pdftoppm`, `pdfinfo`), pypdf, RapidOCR mit ONNX Runtime |
| Suche | SQLite FTS5 mit BM25 und Trigrammen, Suchbegriffe vom Modell erweitert, keine Embeddings |
| Externe Daten | requests, astral (Sonnen- und Mondstand), airportsdata; Abfragen unter anderem an Open-Meteo |
| Export | openpyxl |
| Frontend | React 19, TypeScript, Vite, `@xyflow/react` (Beweisboard), lucide-react, eigenes CSS ohne UI-Bibliothek |
| Ablage | JSON-Dateien je Akte unter `aktenaufbereiter/cases/`, dazu der SQLite-Suchindex |
| Live-Fortschritt | Server-Sent Events |

Versionen und Module stehen in [TECH.md](TECH.md).

## Starten

Voraussetzungen: Python 3.12, Node.js mit npm, `poppler-utils` und ein OpenRouter-API-Key.

```bash
# Backend
cd aktenaufbereiter/backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env          # OPENROUTER_API_KEY eintragen
.venv/bin/uvicorn app.main:app --port 8000

# Frontend, in einem zweiten Terminal
cd aktenaufbereiter/frontend
npm i --legacy-peer-deps
npm run dev                   # http://localhost:5173
```

Ohne Oberfläche:

```bash
cd aktenaufbereiter/backend
.venv/bin/python -m app.cli process "<ordner>" --case <id> --name "<name>"
.venv/bin/python -m app.cli frage "<frage>" --case <id>
```

## Struktur

```text
aktenaufbereiter/
  backend/app/    API, Agent, Prüfung, Suche, Massenverfahren, externe Daten
  frontend/src/   React-Oberfläche
  testdaten/      Testakten für Massenverfahren
PRODUCT.md        Zielgruppe und Designprinzipien
TECH.md           Tech-Stack im Detail
PITCH_TECH.md     Tech-Pitch für die Jury
CLAUDE.md         Regeln und Stolpersteine für die Entwicklung
AGENTS.md         Regeln für den Builder im Orchestrator-Modus
```

Ergebnisse (`cases/`), `.env` und die Daten des Veranstalters (`Challenge 5/`) sind nicht im Repository.

## Grenzen

- **Datenschutz:** Akteninhalte gehen zur Verarbeitung an OpenRouter und das gewählte Modell. Nur Ablage und Suchindex bleiben lokal.
- **Tests:** Es gibt keine automatisierte Testsuite. Geprüft wird über `npx tsc -b`, die Ankerprüfung und Testakten.
- **Open-Meteo:** ist kostenlos nur nicht-kommerziell nutzbar.
