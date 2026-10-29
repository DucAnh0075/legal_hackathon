import json

from pydantic import BaseModel

from .schemas import DocExtraction, PageScan

SYSTEM = """Du bist ein Aktenaufbereiter für den Strafrichter. Aus Aktenbestandteilen eines Strafverfahrens erstellst du strukturierte Übersichten zur Vorbereitung der Hauptverhandlung. Ziel: die Wirklichkeit, wie sie in der Akte repräsentiert ist, schnell und vollständig erfassbar machen.

Regeln (zwingend):
- Beschränke dich auf die in den Akten dokumentierten Informationen. Keine eigenen Vermutungen, keine Wertungen, keine rechtliche Bewertung der Vorwürfe, keine Einschätzung von Erfolgsaussichten.
- Gib bei jeder Information die Fundstelle an: ausschließlich Zeilenanker im Format "A06:L03", die im Dokument wirklich vorkommen. Erfinde keine Anker.
- Bei Widersprüchen (z. B. unterschiedliche Datumsangaben) dokumentiere beide Varianten mit Fundstelle.
- Kennzeichne Unsicherheiten deutlich (DateValue.hinweis, z. B. "Datum unklar", "Name nur teilweise lesbar"; precision "unklar"/"ungefaehr").
- Unterscheide: belegter Vorgang (status "belegt"), Aussage ("aussage"), spätere Korrektur ("korrektur"), offene Frage ("offen").
- Datumsangaben: iso (YYYY-MM-DD, mit Uhrzeit YYYY-MM-DDTHH:MM) und anzeige (TT.MM.JJJJ [HH:MM]). Halte Ereignisdatum (wann es geschah), Dokumentdatum (wann das Dokument erstellt wurde) und Eingangsdatum (wann es einging) strikt getrennt.
- Ereignisse sind entweder kind="geschehen" (Geschehen in der Realität) oder kind="verfahren" (Verfahrensschritt: Anzeige, Vernehmung, Auskunft, Gutachten, Beschluss, Verfügung, Sicherstellung ...).
- Nenne eine Norm (z. B. § 263 StGB) nur, wenn sie in der Akte steht.
- Antworte ausschließlich mit einem JSON-Objekt nach dem vorgegebenen Schema, in deutscher Sprache."""


def extract_prompt(doc_id: str, text: str | None, vision: bool) -> str:
    schema = json.dumps(DocExtraction.model_json_schema(), ensure_ascii=False)
    src = (
        f"Aktenstück {doc_id}. Volltext mit Zeilenankern:\n\n{text}"
        if not vision
        else f"Aktenstück {doc_id} liegt als Bild vor (siehe Anhang). Lies den gesamten sichtbaren Text (OCR) und gib ihn "
             f"in ocr_lines zeilenweise mit Ankern {doc_id}:L01, {doc_id}:L02, ... aus. Verwende diese Anker als Fundstellen. "
             "Unleserliches kennzeichnen, nicht raten."
    )
    return f"""{src}

Extrahiere: Metadaten (title, doc_type, dokumentdatum, eingangsdatum falls genannt, essentialia = Kerninhalt in 1-2 Sätzen), personen (mit Rolle nur wie in der Akte benannt, Adresse nur wenn genannt), entitaeten (Firmen, Konten, Websites, Profile, Objekte, Chips, Fahrzeuge), ereignisse (geschehen/verfahren), aussagen, beziehungen (Person-Person/Firma/Konto), fristen (HV-Termine, Fristen, Adressen), offene_fragen (nur was die Akte selbst als unklar zeigt). doc_id = "{doc_id}".

JSON-Schema:
{schema}"""


FUND = 'Fundstellen als Objekte {"doc_id":"A06","line":"A06:L03"}; nur Anker, die in den Extraktionen vorkommen.'

PARTS = {
    "entities": """Führe Personen und Entitäten über alle Aktenstücke zusammen.
- personen (ID p1, p2 ...): gleiche Person unter verschiedenen Schreibweisen/Aliassen zusammenführen (aliases). adresse nur wenn aus Akte ersichtlich, sonst "nicht aus Akte ersichtlich". rollen wie in der Akte benannt.
- entitaeten (ID e1 ...): Firmen, Konten, Websites, Profile, Objekte, Chips, Fahrzeuge; Dubletten zusammenführen. Keine Verwendungszwecke oder Referenznummern als eigene Entität, außer sie werden als Objekt behandelt.""",
    "events": """Erstelle die Ereignisliste.
- ereignisse (ID ev1 ...): Dubletten über Dokumente zusammenführen (Fundstellen vereinigen). kind "geschehen" (reales Geschehen) oder "verfahren" (Verfahrensschritt mit verfahrens_typ: Anzeige, Vernehmung, Auskunft, Gutachten, Beschluss, Verfügung, Sicherstellung, Vermerk ...). Für jedes Aktenstück, das selbst ein Verfahrensschritt ist, ein verfahren-Ereignis.
- ereignisdatum, dokumentdatum, eingangsdatum strikt getrennt. beteiligte = IDs aus dem Register. Chronologisch ordnen. Kurze, sachliche beschreibung.""",
    "statements": """Erfasse Aussagen und Widersprüche.
- aussagen (ID s1 ...): wesentliche Aussagen von Personen (person_id aus Register), thema, inhalt.
- widersprueche (ID w1 ...): nur echte Abweichungen zwischen oder innerhalb von Dokumenten (Datum, Beträge, Abläufe, Zuordnungen, spätere Korrekturen). Jede Variante mit behauptung, quelle_person (ID) und Fundstellen. Sachlich, ohne Wertung.""",
    "rest": """Erfasse Beziehungen, Tatkomplexe, Fristen und offene Fragen.
- beziehungen (ID r1 ...): von/zu = IDs aus dem Register (Person-Person, Person-Firma, Person-Konto, Konto-Konto/Zahlungsfluss, Person-Website/Profil). beziehung kurz (z. B. "Geschäftspartner", "Kontakt per Chat", "Kontoinhaberin", "überweist an").
- tatkomplexe (ID t1 ...): Gruppierung der Vorwürfe laut Akte; vorwurf_laut_akte nur wenn in der Akte benannt, sonst "in Akte nicht benannt"; zeitraum; personen (IDs); beweismittel (Dokument-IDs).
- fristen (ID f1 ...): HV-Termine, Fristen, verfahrensrelevante Adressen.
- offene_fragen (ID o1 ...): nur was die Akte selbst als ungeklärt ausweist.""",
}


def consolidate_prompt(part: str, schema: type[BaseModel], extractions: list[DocExtraction], blatt: dict[str, str],
                       registry: str | None, existing: str | None) -> str:
    data = json.dumps([e.model_dump(exclude_none=True, exclude={"ocr_lines"}) for e in extractions], ensure_ascii=False)
    reg = f"\n\nREGISTER (verwende ausschließlich diese IDs):\n{registry}" if registry else ""
    add = ("\n\nBESTAND (unverändert lassen, nur ergänzen; neue IDs fortlaufend nach den bestehenden):\n" + existing) if existing else ""
    return f"""{PARTS[part]}
{FUND}

Blattzahlen: {json.dumps(blatt)}{reg}{add}

EXTRAKTIONEN:
{data}

Antworte nur mit JSON nach diesem Schema:
{json.dumps(schema.model_json_schema(), ensure_ascii=False)}"""


def page_prompt(page: int, total: int, text: str | None) -> str:
    schema = json.dumps(PageScan.model_json_schema(), ensure_ascii=False)
    src = (f"Seite {page} von {total} einer Strafakte (Textschicht):\n\n{text}" if text else
           f"Seite {page} von {total} einer gescannten Strafakte (siehe Bild).")
    return f"""{src}

Aufgaben:
- ocr_lines: den gesamten sichtbaren Text zeilenweise in Lesereihenfolge, wörtlich, auch Handschrift und Stempel. Unleserliches als [unleserlich] markieren, nicht raten. Formularfelder als "Feldname: Wert".
- neues_dokument: true, wenn auf dieser Seite ein neues Schriftstück beginnt (eigener Kopf, Briefkopf, Formulartitel, Aktendeckel, Gesetzestext, neue Vernehmung, Vermerk, Beschluss ...); false, wenn die Seite ein vorheriges Schriftstück fortsetzt.
- doc_type und title: Art und Titel des Schriftstücks, z. B. "Aktendeckel", "Strafanzeige", "Vernehmung", "Vermerk", "Auskunft Bundeszentralregister", "Gesetzestext".
- datum: Datum des Schriftstücks, falls auf der Seite erkennbar.
- blatt_handschriftlich: handschriftliche oder gestempelte Blattzahl (meist oben rechts), nur die Zahl; null, wenn keine erkennbar.
- unleserlich: Stellen, die nicht sicher lesbar sind.

JSON-Schema:
{schema}"""
