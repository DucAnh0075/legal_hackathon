"""Datenmodell des Aktenaufbereiters. Einzige Quelle der Wahrheit für Backend, API und Frontend-Typen.

Grundregel: Nur Inhalte aus der Akte, keine Wertung. Jede Angabe trägt Fundstellen.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

DocFormat = Literal["md", "pdf_text", "pdf_image", "image"]
EventKind = Literal["geschehen", "verfahren"]
EventStatus = Literal["belegt", "aussage", "korrektur", "offen"]
DatePrecision = Literal["tag", "uhrzeit", "ungefaehr", "unklar"]


class TextLine(BaseModel):
    anchor: str  # z. B. "A06:L03"
    text: str
    seite: int | None = None  # PDF-Seite der Sammelakte
    blatt: str | None = None  # handschriftliche Blattzahl dieser Seite, falls erkannt


class Fundstelle(BaseModel):
    doc_id: str
    line: str | None = None  # Zeilenanker, z. B. "A06:L03"
    blatt: str | None = None  # z. B. "Bl. 3"
    unklar: bool = False  # True, wenn die Validierung die Stelle nicht auflösen konnte


class DateValue(BaseModel):
    iso: str | None = None  # YYYY-MM-DD oder YYYY-MM-DDTHH:MM
    anzeige: str | None = None  # TT.MM.JJJJ [HH:MM]
    precision: DatePrecision = "tag"
    hinweis: str | None = None  # z. B. "Datum unklar"


class Representation(BaseModel):
    format: DocFormat
    path: str  # Originalpfad
    sorted_path: str | None = None


class Document(BaseModel):
    id: str  # A01, B12, ...
    title: str = ""
    doc_type: str = ""
    format: DocFormat
    representations: list[Representation] = []
    original_filename: str
    sorted_path: str | None = None
    blatt_von: int | None = None
    blatt_bis: int | None = None
    herkunft: str | None = None  # "Polizei", "Staatsanwaltschaft", "Gericht", "Verteidigung", "Privat/Beteiligte", "Sonstige"; nur aus Dokument ersichtlich
    dokumentdatum: DateValue | None = None
    eingangsdatum: DateValue | None = None
    essentialia: str = ""
    text_lines: list[TextLine] = []
    needs_vision: bool = False  # Bild oder PDF ohne Textschicht
    aus_sammelakte: bool = False  # aus einer mehrseitigen PDF gegliedert; blatt_von/bis = PDF-Seiten
    blatt_hand: str | None = None  # handschriftliche Blattangabe, z. B. "1–3"


class PageScan(BaseModel):
    """Eine Seite einer Sammelakte: gelesen und eingeordnet."""
    ocr_lines: list[str] = []
    neues_dokument: bool = False
    doc_type: str = ""
    title: str = ""
    datum: DateValue | None = None
    blatt_handschriftlich: str | None = None
    unleserlich: list[str] = []


# ---- Extraktion je Dokument -------------------------------------------------

class PersonMention(BaseModel):
    name: str
    aliases: list[str] = []
    adresse: str | None = None
    rolle: str | None = None  # nur wie in der Akte benannt
    fundstellen: list[str] = []  # Zeilenanker


class EntityMention(BaseModel):
    typ: Literal["firma", "konto", "website", "profil", "objekt", "chip", "fahrzeug", "sonstiges"]
    label: str
    details: str | None = None
    fundstellen: list[str] = []


class EventMention(BaseModel):
    kind: EventKind
    verfahrens_typ: str | None = None  # Anzeige, Vernehmung, Gutachten, Auskunft, Beschluss, Verfügung, ...
    ereignisdatum: DateValue | None = None
    beschreibung: str
    beteiligte: list[str] = []
    status: EventStatus = "belegt"
    fundstellen: list[str] = []


class StatementMention(BaseModel):
    person: str
    thema: str
    inhalt: str
    datum: DateValue | None = None
    fundstellen: list[str] = []


class RelationMention(BaseModel):
    von: str
    beziehung: str
    zu: str
    bemerkung: str | None = None
    fundstellen: list[str] = []


class FristMention(BaseModel):
    art: str  # HV-Termin / Frist / Adresse / ...
    datum: DateValue | None = None
    beschreibung: str
    fundstellen: list[str] = []


class DocExtraction(BaseModel):
    doc_id: str
    title: str
    doc_type: str
    herkunft: str | None = None  # "Polizei", "Staatsanwaltschaft", "Gericht", "Verteidigung", "Privat/Beteiligte", "Sonstige"; nur aus Dokument ersichtlich
    dokumentdatum: DateValue | None = None
    eingangsdatum: DateValue | None = None
    essentialia: str
    ocr_lines: list[TextLine] = []  # nur bei Bildern/Bild-PDFs
    personen: list[PersonMention] = []
    entitaeten: list[EntityMention] = []
    ereignisse: list[EventMention] = []
    aussagen: list[StatementMention] = []
    beziehungen: list[RelationMention] = []
    fristen: list[FristMention] = []
    offene_fragen: list[str] = []


# ---- Konsolidierter Fall ----------------------------------------------------

class Person(BaseModel):
    id: str
    name: str
    aliases: list[str] = []
    adresse: str = "nicht aus Akte ersichtlich"
    rollen: list[str] = []
    fundstellen: list[Fundstelle] = []


class Entity(BaseModel):
    id: str
    typ: str
    label: str
    details: str | None = None
    fundstellen: list[Fundstelle] = []


class Event(BaseModel):
    id: str
    kind: EventKind
    verfahrens_typ: str | None = None
    ereignisdatum: DateValue | None = None
    dokumentdatum: DateValue | None = None
    eingangsdatum: DateValue | None = None
    beschreibung: str
    beteiligte: list[str] = []  # Person-/Entity-IDs
    status: EventStatus = "belegt"
    fundstellen: list[Fundstelle] = []


class Statement(BaseModel):
    id: str
    person_id: str
    thema: str
    inhalt: str
    datum: DateValue | None = None
    fundstellen: list[Fundstelle] = []


class Variante(BaseModel):
    behauptung: str
    quelle_person: str | None = None
    fundstellen: list[Fundstelle] = []


class Contradiction(BaseModel):
    id: str
    thema: str
    varianten: list[Variante]
    hinweis: str | None = None  # nur sachlich, z. B. "Datumsangaben weichen ab"


class Relation(BaseModel):
    id: str
    von: str  # Person-/Entity-ID
    beziehung: str
    zu: str
    bemerkung: str | None = None
    fundstellen: list[Fundstelle] = []


class Tatkomplex(BaseModel):
    id: str
    label: str
    vorwurf_laut_akte: str = "in Akte nicht benannt"
    zeitraum: str = ""
    personen: list[str] = []
    beweismittel: list[str] = []  # Dokument-IDs
    fundstellen: list[Fundstelle] = []


class FristTermin(BaseModel):
    id: str
    art: str
    datum: DateValue | None = None
    beschreibung: str
    fundstellen: list[Fundstelle] = []


class OffeneFrage(BaseModel):
    id: str
    frage: str
    fundstellen: list[Fundstelle] = []


class Consolidation(BaseModel):
    """Ausgabe der Konsolidierung (Modell). IDs werden danach deterministisch vergeben."""
    personen: list[Person] = []
    entitaeten: list[Entity] = []
    ereignisse: list[Event] = []
    aussagen: list[Statement] = []
    widersprueche: list[Contradiction] = []
    beziehungen: list[Relation] = []
    tatkomplexe: list[Tatkomplex] = []
    fristen: list[FristTermin] = []
    offene_fragen: list[OffeneFrage] = []


class ConsEntities(BaseModel):
    personen: list[Person] = []
    entitaeten: list[Entity] = []


class ConsEvents(BaseModel):
    ereignisse: list[Event] = []


class ConsStatements(BaseModel):
    aussagen: list[Statement] = []
    widersprueche: list[Contradiction] = []


class ConsRest(BaseModel):
    beziehungen: list[Relation] = []
    tatkomplexe: list[Tatkomplex] = []
    fristen: list[FristTermin] = []
    offene_fragen: list[OffeneFrage] = []


class Case(Consolidation):
    id: str
    name: str
    dokumente: list[Document] = []
    warnungen: list[str] = Field(default_factory=list)  # Validierungsbefunde


class Annotation(BaseModel):
    kanzlei: str = "offen"
    mandant: str = "offen"


class ReviewBeziehung(BaseModel):
    id: str
    art: Literal["verhaeltnis", "verfahren", "handlung", "sonstiges"]


class ReviewWiderspruch(BaseModel):
    id: str
    art: Literal["echt", "schreibweise"]


class Review(BaseModel):
    beziehungen: list[ReviewBeziehung] = []
    widersprueche: list[ReviewWiderspruch] = []
