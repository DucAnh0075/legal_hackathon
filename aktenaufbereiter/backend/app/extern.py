"""Externe Daten: Das Modell schlägt Ideen vor und plant nur vom Richter angefragte Abrufe.

Nicht Akteninhalt: Ideen und neutrale Berichte liegen getrennt in extern.json, case.json bleibt unberührt.
Das Modell sieht keine abgerufenen Werte. Gesendet werden nur Gemeinde, Datum, Flughafen, Domain und Währung.
"""
from __future__ import annotations

import asyncio
import csv
import hashlib
import io
import json
import logging
import os
import re
import threading
import unicodedata
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from functools import lru_cache
from typing import Callable, Literal
from zoneinfo import ZoneInfo
from uuid import uuid4

import airportsdata
import requests
from astral import Observer, moon
from astral.sun import sun
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from . import config, llm, store
from .prompts import SYSTEM_EXTERN_IDEEN, SYSTEM_EXTERN_PLAN, extern_ideen_prompt, extern_plan_prompt
from .schemas import Case, ExternAbruf, ExternAufruf, ExternBericht, ExternIdeen, ExternPlan, ExternWert, Fundstelle
from .validate import blatt_label

log = logging.getLogger(__name__)

MAX_ABRUFE = 12
MAX_ZEITZONEN = 30
DATENART = {"wetter": "Wetter", "zeitzone": "Zeitzonen", "licht": "Licht und Dämmerung", "flugwetter": "Flugwetter",
           "kalender": "Kalender", "kurs": "Wechselkurs", "domain": "Domain", "webarchiv": "Webarchiv"}
_extern_lock = threading.Lock()
CACHE = config.CASES_DIR / "extern_cache.json"
_cache_lock = threading.Lock()
UA = {"User-Agent": "Aktenaufbereiter/0.1 (Legal Hackathon)"}
INSTITUTION = re.compile(r"gmbh|\bag\b|\bug\b|\bltd\b|\bkg\b|\bohg\b|\bev\b|e\.\s?v\.|gericht|staatsanwaltschaft|polizei|kanzlei|kaufhaus|klinik|praxis|bank|\bair\b|airline|airport|flughafen|amt\b", re.I)
WERTUNG = re.compile(r"spricht (für|gegen)|glaubwürdig|glaubhaft|widerleg|bestätigt|beweist|unwahr|schuld", re.I)
STRASSE = re.compile(r"(straße|strasse|str\.|gasse|allee|\bweg\b|\bplatz\b)", re.I)
WOCHENTAGE = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"]
MONATE = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"]
WAEHRUNG_NAMEN = {"USD": ["dollar"], "GBP": ["pfund"], "CHF": ["franken"], "JPY": ["yen"], "PLN": ["zloty"], "TRY": ["lira"]}
BEDINGUNG = {"dry": "trocken", "fog": "Nebel", "rain": "Regen", "sleet": "Schneeregen", "snow": "Schnee", "hail": "Hagel", "thunderstorm": "Gewitter"}
WMO = [(0, "klar"), (3, "bewölkt"), (48, "Nebel"), (57, "Sprühregen"), (67, "Regen"), (77, "Schnee"), (82, "Regenschauer"), (86, "Schneeschauer"), (99, "Gewitter")]


class KeinErgebnis(Exception):
    pass


class Verworfen(Exception):
    pass


@dataclass
class Antwort:
    status: int
    text: str
    url: str
    abgerufen_am: str

    def json(self):
        return json.loads(self.text)


def _jetzt() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _holen(url: str, params: dict | None = None, ablauf_tage: int | None = None) -> Antwort:
    """HTTP-GET mit dauerhaftem Cache je URL; vergangene Tage ändern sich nicht, dieselbe Anfrage geht nur einmal raus."""
    voll = requests.Request("GET", url, params=params).prepare().url
    with _cache_lock:
        cache = json.loads(CACHE.read_text(encoding="utf-8")) if CACHE.exists() else {}
    e = cache.get(voll)
    if e and not (ablauf_tage and datetime.now(timezone.utc) - datetime.fromisoformat(e["am"]) > timedelta(days=ablauf_tage)):
        return Antwort(e["status"], e["text"], voll, e["am"])
    for versuch in (0, 1):
        try:
            r = requests.get(voll, headers=UA, timeout=25)
            if r.status_code < 500 and r.status_code != 429:
                break
        except requests.RequestException:
            if versuch:
                raise
    if r.status_code >= 500 or r.status_code == 429:
        raise requests.RequestException(f"HTTP {r.status_code}")
    am = _jetzt()
    with _cache_lock:
        cache = json.loads(CACHE.read_text(encoding="utf-8")) if CACHE.exists() else {}
        cache[voll] = {"status": r.status_code, "text": r.text, "am": am}
        tmp = CACHE.with_suffix(".tmp")
        tmp.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, CACHE)
    return Antwort(r.status_code, r.text, voll, am)


# ---- Parameter ---------------------------------------------------------------

DATUM = r"^\d{4}-\d{2}-\d{2}$"
ZEIT = r"^([01]\d|2[0-3]):[0-5]\d$"


class _P(BaseModel):
    model_config = ConfigDict(extra="forbid")


class OrtP(_P):
    ort: str = Field(pattern=r"^[^\W\d_][^\W\d_ .'’-]*([ .'’-]+[^\W\d_]+)*\.?$", max_length=60)
    land: str | None = Field(None, pattern=r"^[A-Z]{2}$")  # ISO-Ländercode, falls aus der Akte ersichtlich
    datum: str = Field(pattern=DATUM)
    uhrzeit: str | None = Field(None, pattern=ZEIT)


class ZeitzoneP(_P):
    ort: str = Field(pattern=r"^[^\W\d_][^\W\d_ .'’-]*([ .'’-]+[^\W\d_]+)*\.?$", max_length=60)
    land: str | None = Field(None, pattern=r"^[A-Z]{2}$")
    datum: str | None = Field(None, pattern=DATUM)
    uhrzeit: str | None = Field(None, pattern=ZEIT)


class FlugP(_P):
    icao: str = Field(pattern=r"^[A-Z0-9]{4}$")
    datum: str = Field(pattern=DATUM)
    uhrzeit: str | None = Field(None, pattern=ZEIT)


class KalenderP(_P):
    datum: str = Field(pattern=DATUM)
    bundesland: Literal["BW", "BY", "BE", "BB", "HB", "HH", "HE", "MV", "NI", "NW", "RP", "SL", "SN", "ST", "SH", "TH"] | None = None


class DomainP(_P):
    domain: str = Field(pattern=r"^([a-z0-9-]+\.)+[a-z]{2,}$", max_length=120)


class ArchivP(DomainP):
    datum: str = Field(pattern=DATUM)


class KursP(_P):
    waehrung: str = Field(pattern=r"^[A-Z]{3}$")
    datum: str = Field(pattern=DATUM)


# ---- Quellen -----------------------------------------------------------------

@dataclass
class Ausgabe:
    werte: list[ExternWert]
    quelle: str
    url: str | None = None
    abgerufen_am: str | None = None
    hinweis: str | None = None


def _w(label: str, wert) -> ExternWert:
    return ExternWert(label=label, wert=str(wert))


def _geo(ort: str, land: str | None) -> tuple[dict, Antwort]:
    a = _holen("https://geocoding-api.open-meteo.com/v1/search",
               {"name": ort, "count": 1, "language": "de", **({"countryCode": land} if land else {})})
    treffer = a.json().get("results") or []
    if not treffer:
        raise KeinErgebnis(f"Ort „{ort}“ nicht gefunden")
    return treffer[0], a


def _ort_wert(g: dict) -> ExternWert:
    teile = [g["name"], g.get("admin1"), g.get("country")]
    return _w("Aufgelöster Ort", f"{', '.join(t for t in teile if t)} ({g['latitude']:.2f}, {g['longitude']:.2f})")


def _stunde(zeilen: list[tuple[str, dict]], uhrzeit: str) -> tuple[str, dict]:
    ziel = int(uhrzeit[:2]) * 60 + int(uhrzeit[3:])
    return min(zeilen, key=lambda z: abs(int(z[0][11:13]) * 60 + int(z[0][14:16]) - ziel))


def _summe(werte) -> float | None:
    werte = [v for v in werte if v is not None]
    return round(sum(werte), 1) if werte else None


def _wetter_de(g: dict, p: OrtP) -> Ausgabe:
    tag = date.fromisoformat(p.datum)
    a = _holen("https://api.brightsky.dev/weather", {"lat": round(g["latitude"], 3), "lon": round(g["longitude"], 3),
               "date": f"{tag}T00:00", "last_date": f"{tag + timedelta(days=1)}T00:00", "tz": g.get("timezone", "Europe/Berlin")})
    if a.status != 200:
        raise KeinErgebnis("Keine Stationsdaten")
    d = a.json()
    quellen = {s["id"]: s for s in d.get("sources", [])}
    zeilen = [(w["timestamp"], w) for w in d.get("weather", []) if w["timestamp"].startswith(p.datum)
              and quellen.get(w.get("source_id"), {}).get("observation_type") != "forecast"]
    if not zeilen:
        raise KeinErgebnis("Keine Stationsdaten")
    werte = [_ort_wert(g)]
    if p.uhrzeit:
        zeit, w = _stunde(zeilen, p.uhrzeit)
        s = quellen.get(w.get("source_id"), {})
        if s.get("station_name"):
            werte.append(_w("Station", f"{s['station_name']} ({s.get('distance', 0) / 1000:.1f} km entfernt)"))
        for label, feld, einheit in (("Temperatur", "temperature", "°C"), ("Niederschlag", "precipitation", "mm/h"), ("Bewölkung", "cloud_cover", "%"),
                                     ("Wind", "wind_speed", "km/h"), ("Böen", "wind_gust_speed", "km/h"), ("Sichtweite", "visibility", "m")):
            if w.get(feld) is not None:
                werte.append(_w(f"{label} ({zeit[11:16]} Uhr)", f"{w[feld]} {einheit}"))
        if w.get("condition") in BEDINGUNG:
            werte.append(_w(f"Wetterlage ({zeit[11:16]} Uhr)", BEDINGUNG[w["condition"]]))
    else:
        s = quellen.get(zeilen[0][1].get("source_id"), {})
        if s.get("station_name"):
            werte.append(_w("Station", f"{s['station_name']} ({s.get('distance', 0) / 1000:.1f} km entfernt)"))
    temp = [w["temperature"] for _, w in zeilen if w.get("temperature") is not None]
    if temp:
        werte.append(_w("Temperatur (Tag)", f"{min(temp)} bis {max(temp)} °C"))
    regen = _summe(w.get("precipitation") for _, w in zeilen)
    if regen is not None:
        werte.append(_w("Niederschlag (Tag)", f"{regen} mm"))
    return Ausgabe(werte, "Bright Sky (Deutscher Wetterdienst)", a.url, a.abgerufen_am, "Stationswerte; gelten für die Station, nicht für den genauen Ort.")


def _wmo(code) -> str | None:
    return next((t for grenze, t in WMO if code is not None and code <= grenze), None)


def _wetter_welt(g: dict, p: OrtP) -> Ausgabe:
    a = _holen("https://archive-api.open-meteo.com/v1/archive", {
        "latitude": round(g["latitude"], 3), "longitude": round(g["longitude"], 3), "start_date": p.datum, "end_date": p.datum, "timezone": "auto",
        "hourly": "temperature_2m,precipitation,cloud_cover,wind_speed_10m,wind_gusts_10m,weather_code",
        "daily": "temperature_2m_min,temperature_2m_max,precipitation_sum"})
    if a.status != 200:
        raise KeinErgebnis("Keine Modelldaten")
    d = a.json()
    h, t = d.get("hourly") or {}, d.get("daily") or {}
    werte = [_ort_wert(g)]
    if p.uhrzeit and h.get("time"):
        zeilen = [(z, {k: h[k][i] for k in h}) for i, z in enumerate(h["time"])]
        zeit, w = _stunde(zeilen, p.uhrzeit)
        for label, feld, einheit in (("Temperatur", "temperature_2m", "°C"), ("Niederschlag", "precipitation", "mm/h"), ("Bewölkung", "cloud_cover", "%"),
                                     ("Wind", "wind_speed_10m", "km/h"), ("Böen", "wind_gusts_10m", "km/h")):
            if w.get(feld) is not None:
                werte.append(_w(f"{label} ({zeit[11:16]} Uhr)", f"{w[feld]} {einheit}"))
        if _wmo(w.get("weather_code")):
            werte.append(_w(f"Wetterlage ({zeit[11:16]} Uhr)", _wmo(w["weather_code"])))
    if (t.get("temperature_2m_min") or [None])[0] is not None:
        werte.append(_w("Temperatur (Tag)", f"{t['temperature_2m_min'][0]} bis {t['temperature_2m_max'][0]} °C"))
    if (t.get("precipitation_sum") or [None])[0] is not None:
        werte.append(_w("Niederschlag (Tag)", f"{t['precipitation_sum'][0]} mm"))
    if len(werte) == 1:
        raise KeinErgebnis("Für diesen Tag liegen noch keine Modelldaten vor")
    return Ausgabe(werte, "Open-Meteo Historical Weather", a.url, a.abgerufen_am, "Modelldaten für eine Rasterzelle, kein Messwert.")


def wetter(p: OrtP) -> Ausgabe:
    g, _ = _geo(p.ort, p.land)
    if g.get("country_code") == "DE":
        try:
            return _wetter_de(g, p)
        except KeinErgebnis:
            pass
    return _wetter_welt(g, p)


def zeitzone(p: ZeitzoneP, zeitbezug: tuple[str, str | None]) -> Ausgabe:
    g, a = _geo(p.ort, p.land)
    if not g.get("timezone"):
        raise KeinErgebnis("Zeitzone des Ortes unbekannt")
    tz = ZoneInfo(g["timezone"])
    werte = [_w("Ort", g["name"])]
    hinweis = None
    lokal = None
    if p.datum:
        tag = date.fromisoformat(p.datum)
        werte.append(_w("Datum", tag.strftime("%d.%m.%Y")))
        lokal = datetime.fromisoformat(f"{p.datum}T{p.uhrzeit or '12:00'}").replace(tzinfo=tz)
        if p.uhrzeit:
            werte.append(_w("Uhrzeit", f"{p.uhrzeit} Uhr"))
    elif p.uhrzeit:
        hinweis = "Uhrzeit ohne Datum wurde ignoriert."
    werte.append(_w("Zeitzone", f"{tz.key} ({lokal.tzname()})" if lokal else tz.key))
    if lokal:
        minuten = int(lokal.utcoffset().total_seconds() // 60)
        stunden, rest = divmod(abs(minuten), 60)
        versatz = f"UTC{'+' if minuten >= 0 else '−'}{stunden}" + (f":{rest:02d}" if rest else "")
    else:
        versatz = "je nach Datum"
    werte.append(_w("UTC-Versatz", versatz))
    if lokal and p.uhrzeit:
        kuerzel = zeitbezug[1]
        if kuerzel:
            offset = {"UTC": 0, "GMT": 0, "MEZ": 1, "CET": 1, "MESZ": 2, "CEST": 2}[kuerzel]
            lokal = lokal.replace(tzinfo=timezone(timedelta(hours=offset)))
        for label, ziel in (("UTC", timezone.utc), ("Deutschland", ZoneInfo("Europe/Berlin"))):
            zeit = lokal.astimezone(ziel)
            wert = zeit.strftime("%H:%M Uhr")
            if zeit.date() != tag:
                wert += zeit.strftime(" (%d.%m.%Y)")
            werte.append(_w(label, wert))
    werte.append(_w("Zeitbezug", zeitbezug[0]))
    return Ausgabe(werte, "IANA-Zeitzonendatenbank (lokale Berechnung), Koordinaten von Open-Meteo Geocoding",
                   a.url, a.abgerufen_am, hinweis)


def licht(p: OrtP) -> Ausgabe:
    g, a = _geo(p.ort, p.land)
    if not g.get("timezone"):
        raise KeinErgebnis("Zeitzone des Ortes unbekannt")
    tag = date.fromisoformat(p.datum)
    try:
        s = sun(Observer(g["latitude"], g["longitude"]), date=tag, tzinfo=ZoneInfo(g["timezone"]))
    except ValueError as e:
        raise KeinErgebnis("Sonnenstand für diesen Tag nicht berechenbar") from e
    werte = [_ort_wert(g)] + [_w(l, s[k].strftime("%H:%M Uhr")) for l, k in (
        ("Beginn bürgerliche Dämmerung", "dawn"), ("Sonnenaufgang", "sunrise"), ("Sonnenuntergang", "sunset"), ("Ende bürgerliche Dämmerung", "dusk"))]
    tage = moon.phase(tag)
    werte.append(_w("Mondphase", next(t for g2, t in ((1.5, "Neumond"), (5.5, "zunehmende Sichel"), (8.5, "erstes Viertel"), (12.5, "zunehmender Mond"), (15.5, "Vollmond"),
                                                       (19.5, "abnehmender Mond"), (22.5, "letztes Viertel"), (26.5, "abnehmende Sichel"), (99, "Neumond")) if tage <= g2)))
    return Ausgabe(werte, "Astronomische Berechnung (astral), Koordinaten von Open-Meteo Geocoding", a.url, a.abgerufen_am,
                   f"Berechnet für das Ortszentrum ohne Gelände und Bewölkung; Ortszeit {g['timezone']}.")


def kalender(p: KalenderP) -> Ausgabe:
    tag = date.fromisoformat(p.datum)
    land = p.bundesland or "NATIONAL"
    a = _holen("https://feiertage-api.de/api/", {"jahr": tag.year, "nur_land": land})
    if a.status != 200:
        raise KeinErgebnis("Feiertagsliste nicht verfügbar")
    feiertag = next((n for n, f in a.json().items() if f.get("datum") == p.datum), None)
    gebiet = p.bundesland or "bundesweit"
    return Ausgabe([_w("Wochentag", WOCHENTAGE[tag.weekday()]), _w("Kalenderwoche", tag.isocalendar()[1]),
                    _w(f"Feiertag ({gebiet})", feiertag or "keiner")], "feiertage-api.de; Wochentag berechnet", a.url, a.abgerufen_am)


@lru_cache
def _flughaefen() -> dict:
    return airportsdata.load("ICAO")


def flugwetter(p: FlugP) -> Ausgabe:
    f = _flughaefen()[p.icao]
    tz = ZoneInfo(f["tz"])
    tag = date.fromisoformat(p.datum)
    start = datetime(tag.year, tag.month, tag.day, tzinfo=tz).astimezone(timezone.utc)
    ende = start + timedelta(days=2)  # ganze UTC-Tage, damit jeder Abruf desselben Tages denselben Cache-Eintrag trifft
    a = _holen("https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py", {
        "station": p.icao, "data": "metar", "tz": "UTC", "format": "onlycomma", "latlon": "no", "missing": "empty", "trace": "empty",
        "year1": start.year, "month1": start.month, "day1": start.day, "year2": ende.year, "month2": ende.month, "day2": ende.day})
    if a.status != 200:
        raise KeinErgebnis("Keine METAR-Meldungen")
    meldungen = []
    for z in csv.DictReader(io.StringIO(a.text)):
        if not z.get("valid") or not z.get("metar"):
            continue
        lokal = datetime.fromisoformat(z["valid"]).replace(tzinfo=timezone.utc).astimezone(tz)
        if lokal.date() == tag:
            meldungen.append((lokal, z["metar"].strip()))
    if not meldungen:
        raise KeinErgebnis(f"Keine METAR-Meldungen für {p.icao} an diesem Tag")
    if p.uhrzeit:
        ziel = datetime(tag.year, tag.month, tag.day, int(p.uhrzeit[:2]), int(p.uhrzeit[3:]), tzinfo=tz)
        auszug = [m for m in meldungen if abs(m[0] - ziel) <= timedelta(minutes=90)] or [min(meldungen, key=lambda m: abs(m[0] - ziel))]
        hinweis = "Originalmeldungen im Wortlaut, 90 Minuten um die angefragte Uhrzeit."
    else:
        schritt = max(1, len(meldungen) // 8)
        auszug = meldungen[::schritt]
        hinweis = f"Originalmeldungen im Wortlaut; Auszug von {len(auszug)} aus {len(meldungen)} Meldungen des Tages."
    werte = [_w("Flughafen", f"{f['name']} ({p.icao})")] + [_w(m[0].strftime("%H:%M Uhr"), m[1]) for m in auszug]
    return Ausgabe(werte, "Iowa Environmental Mesonet (METAR)", a.url, a.abgerufen_am, f"{hinweis} Zeiten in Ortszeit ({f['tz']}).")


def domain(p: DomainP) -> Ausgabe:
    a = _holen(f"https://rdap.org/domain/{p.domain}", ablauf_tage=30)
    if a.status != 200:
        raise KeinErgebnis("Keine Registrierungsdaten öffentlich verfügbar")
    d = a.json()
    werte = []
    for label, aktion in (("Registriert", "registration"), ("Letzte Änderung", "last changed"), ("Läuft ab", "expiration")):
        e = next((e["eventDate"] for e in d.get("events", []) if e.get("eventAction") == aktion), None)
        if e:
            werte.append(_w(label, datetime.fromisoformat(e.replace("Z", "+00:00")).strftime("%d.%m.%Y")))
    for e in d.get("entities", []):
        if "registrar" in e.get("roles", []):
            name = next((v[3] for v in (e.get("vcardArray") or [None, []])[1] if v[0] == "fn"), None)
            if name:
                werte.append(_w("Registrar", name))
    if not werte:
        raise KeinErgebnis("Keine Registrierungsdaten öffentlich verfügbar")
    return Ausgabe(werte, "RDAP (rdap.org)", a.url, a.abgerufen_am, "Stand des Abrufs, kein historischer Stand. Inhaberdaten werden nicht übernommen.")


def webarchiv(p: ArchivP) -> Ausgabe:
    a = _holen("https://archive.org/wayback/available", {"url": p.domain, "timestamp": p.datum.replace("-", "")})
    nah = (a.json().get("archived_snapshots") or {}).get("closest") if a.status == 200 else None
    if not nah or not nah.get("available"):
        raise KeinErgebnis("Keine archivierte Fassung gefunden")
    zeit = datetime.strptime(nah["timestamp"], "%Y%m%d%H%M%S")
    abstand = abs((zeit.date() - date.fromisoformat(p.datum)).days)
    return Ausgabe([_w("Nächste Fassung", zeit.strftime("%d.%m.%Y %H:%M Uhr UTC")), _w("Abstand zum Datum", f"{abstand} Tage"),
                    ExternWert(label="Archiv", wert="Fassung öffnen", link=f"https://web.archive.org/web/{nah['timestamp']}/{p.domain}")],
                   "Internet Archive (Wayback Machine)", a.url, a.abgerufen_am)


def kurs(p: KursP) -> Ausgabe:
    a = _holen(f"https://api.frankfurter.dev/v1/{p.datum}", {"base": "EUR", "symbols": p.waehrung})
    wert = a.json().get("rates", {}).get(p.waehrung) if a.status == 200 else None
    if wert is None:
        raise KeinErgebnis(f"Kein EZB-Kurs für {p.waehrung}")
    kursdatum = a.json()["date"]
    return Ausgabe([_w("Kurs", f"1 EUR = {wert} {p.waehrung}"), _w("Kursdatum", datetime.strptime(kursdatum, "%Y-%m-%d").strftime("%d.%m.%Y"))],
                   "Frankfurter (Referenzkurse der EZB)", a.url, a.abgerufen_am,
                   None if kursdatum == p.datum else "Für das angefragte Datum gibt es keinen Kurs; angezeigt ist der letzte davor.")


@dataclass
class Tool:
    parameter: type[_P]
    fn: Callable[..., Ausgabe]
    beschreibung: str


TOOLS: dict[str, Tool] = {
    "zeitzone": Tool(ZeitzoneP, zeitzone, "Zeitzone, UTC-Versatz und Zeitumrechnung. Parameter: ort, land (optional, zweistelliger ISO-Code wie DE), datum (optional), uhrzeit (optional)"),
    "wetter": Tool(OrtP, wetter, "Witterung an einem Ort und Tag, mit uhrzeit auch zur Stunde. Parameter: ort, land (optional, zweistelliger ISO-Code wie DE), datum, uhrzeit (optional)"),
    "licht": Tool(OrtP, licht, "Sonnenauf- und -untergang, Dämmerung, Mondphase. Parameter: ort, land (optional, zweistelliger ISO-Code wie DE), datum"),
    "kalender": Tool(KalenderP, kalender, "Wochentag und deutscher Feiertag. Parameter: datum, bundesland (optional, Kürzel wie BY; nur wenn der Ort in der Akte steht)"),
    "flugwetter": Tool(FlugP, flugwetter, "METAR-Meldungen eines Flughafens. Parameter: icao (z. B. EDDH), datum, uhrzeit (optional)"),
    "domain": Tool(DomainP, domain, "Registrierungsdaten einer in der Akte genannten Domain. Parameter: domain"),
    "webarchiv": Tool(ArchivP, webarchiv, "Nächste archivierte Fassung einer in der Akte genannten Webseite. Parameter: domain, datum"),
    "kurs": Tool(KursP, kurs, "EZB-Wechselkurs zum Euro für eine in der Akte genannte Währung. Parameter: waehrung (z. B. USD), datum"),
}


# ---- Prüfung -----------------------------------------------------------------

def _im_text(wert: str, text: str) -> bool:
    return re.search(rf"(?<!\w){re.escape(wert.casefold())}(?!\w)", text) is not None


def _ohne_akzent(text: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", text) if not unicodedata.combining(c))


def _datum_belegt(datum: str, text: str, case: Case, docs: set[str]) -> bool:
    t = date.fromisoformat(datum)
    formen = {datum, f"{t.day:02d}.{t.month:02d}.{t.year}", f"{t.day}.{t.month}.{t.year}", f"{t.day:02d}.{t.month:02d}.{t.year % 100:02d}",
              f"{t.day}. {MONATE[t.month - 1]} {t.year}", f"{t.day:02d}. {MONATE[t.month - 1]} {t.year}"}
    if any(f.casefold() in text for f in formen):
        return True
    for e in [*case.ereignisse, *case.fristen]:
        d = e.ereignisdatum if hasattr(e, "ereignisdatum") else e.datum
        if d and (d.iso or "").startswith(datum) and any(f.doc_id in docs for f in e.fundstellen):
            return True
    return False


def _uhrzeit_belegt(uhrzeit: str, datum: str, text: str, case: Case, docs: set[str]) -> bool:
    h, m = uhrzeit.split(":")
    if any(f in text for f in (uhrzeit, f"{h}.{m}", f"{int(h)}:{m}", f"{int(h)}.{m}")):
        return True
    return any(e.ereignisdatum and (e.ereignisdatum.iso or "").startswith(f"{datum}T{uhrzeit}") and any(f.doc_id in docs for f in e.fundstellen)
               for e in case.ereignisse)


def _namen(case: Case) -> list[str]:
    """Namensteile natürlicher Personen; Institutionen wie „Landgericht Hamburg“ dürfen den Ort nicht sperren."""
    teile = {t.casefold() for p in case.personen for n in [p.name, *p.aliases] if not INSTITUTION.search(n) for t in re.findall(r"[^\W\d_]{4,}", n)}
    return sorted(teile)


def _zeitbezug(zeilen_text: str) -> tuple[str, str | None]:
    if not zeilen_text:
        return "laut Eingabe als Ortszeit gerechnet", None
    treffer = re.search(r"\b(UTC|GMT|MEZ|CET|MESZ|CEST)\b", zeilen_text)
    if treffer:
        kuerzel = treffer.group(1).upper()
        return f"laut Akte {kuerzel}", kuerzel
    if re.search(r"\bOrtszeit\b", zeilen_text, re.I):
        return "Ortszeit laut Akte", None
    return "nicht genannt, als Ortszeit gerechnet", None


def pruefen(a: ExternAufruf, case: Case, eingabe: str = "", richter: bool = False) -> tuple[_P, list[Fundstelle], str | None, tuple[str, str | None]]:
    """Validiert Parameter und Herkunft vor jedem Abruf, ohne externe Quellen aufzurufen."""
    tool = TOOLS.get(a.tool)
    if not tool:
        raise Verworfen(f"Unbekanntes Tool {a.tool}")
    roh = {k: v for k, v in a.parameter.items() if v not in (None, "")}
    if "land" in roh and not (isinstance(roh["land"], str) and re.fullmatch(r"[A-Z]{2}", roh["land"])):
        del roh["land"]
    try:
        p = tool.parameter.model_validate(roh)
    except ValidationError as e:
        raise Verworfen(f"Ungültige Parameter: {', '.join(str(x['loc'][0]) if x['loc'] else x['msg'] for x in e.errors())}") from e
    zeilen = {l.anchor: (d, l) for d in case.dokumente for l in d.text_lines}
    unbekannt = [x for x in a.anker if x not in zeilen]
    if unbekannt:
        raise Verworfen(f"Anker nicht in der Akte: {', '.join(unbekannt)}")
    bezugsanker = a.anker
    if getattr(p, "uhrzeit", None) and len(a.anker) > 1:
        h, m = p.uhrzeit.split(":")
        formen = (p.uhrzeit, f"{h}.{m}", f"{int(h)}:{m}", f"{int(h)}.{m}")
        bezugsanker = [x for x in a.anker if any(f in zeilen[x][1].text for f in formen)] or a.anker
    if isinstance(p, (DomainP, ArchivP)) and len(bezugsanker) > 1:
        bezugsanker = [x for x in bezugsanker if p.domain.casefold() in zeilen[x][1].text.casefold()] or bezugsanker
    fundstellen = [Fundstelle(doc_id=zeilen[x][0].id, line=x, blatt=blatt_label(*zeilen[x])) for x in bezugsanker]
    docs = {zeilen[x][0].id for x in a.anker}
    text = " ".join([eingabe, *(l.text for d in case.dokumente if d.id in docs for l in d.text_lines)]).casefold()
    bezugszeilen = []
    for d in case.dokumente:
        for i, l in enumerate(d.text_lines):
            if l.anchor in bezugsanker:
                bezugszeilen.extend(z.text for z in d.text_lines[i:i + 2])
    zeitbezug = _zeitbezug("\n".join(bezugszeilen) if a.anker else "")
    hinweis = None
    if isinstance(p, (OrtP, ZeitzoneP)):
        if any(_im_text(n, p.ort.casefold()) for n in _namen(case)):
            raise Verworfen("Parameter enthält einen Personennamen aus der Akte; nicht gesendet")
        if STRASSE.search(p.ort):
            raise Verworfen("Parameter enthält eine Straßenangabe; nicht gesendet")
        if not richter and not _im_text(p.ort, text):
            raise Verworfen(f"Ort „{p.ort}“ steht nicht in Eingabe oder belegtem Dokument")
    if isinstance(p, FlugP):
        f = _flughaefen().get(p.icao)
        if not f:
            raise Verworfen(f"Flughafen {p.icao} unbekannt")
        namen = [p.icao, f["iata"], f["city"], (f["city"] or "").split(" ")[0]]
        ohne_akzent = _ohne_akzent(text)
        if not richter and not any(n and len(n) >= 3 and _im_text(_ohne_akzent(n), ohne_akzent) for n in namen):
            raise Verworfen(f"Flughafen {p.icao} ({f['city']}) nicht aus Eingabe oder belegtem Dokument ersichtlich")
    if isinstance(p, DomainP) and not richter and p.domain.casefold() not in text:
        raise Verworfen(f"Domain {p.domain} steht nicht in Eingabe oder belegtem Dokument")
    if isinstance(p, KursP):
        if p.waehrung == "EUR":
            raise Verworfen("Euro braucht keinen Kurs")
        if not richter and not any(_im_text(n, text) for n in [p.waehrung, *WAEHRUNG_NAMEN.get(p.waehrung, [])]):
            raise Verworfen(f"Währung {p.waehrung} steht nicht in Eingabe oder belegtem Dokument")
    if getattr(p, "datum", None):
        try:
            tag = date.fromisoformat(p.datum)
        except ValueError as e:
            raise Verworfen(f"Ungültiges Datum {p.datum}") from e
        if tag > date.today() and not isinstance(p, ZeitzoneP):
            raise Verworfen("Datum liegt in der Zukunft; es gibt nur Daten zu vergangenen Tagen")
        if not richter and not _datum_belegt(p.datum, text, case, docs):
            raise Verworfen(f"Datum {p.datum} nicht aus Eingabe oder belegtem Dokument ersichtlich")
    if getattr(p, "uhrzeit", None) and not richter and not _uhrzeit_belegt(p.uhrzeit, p.datum, text, case, docs):
        if isinstance(p, ZeitzoneP):
            raise Verworfen(f"Uhrzeit {p.uhrzeit} steht nicht in Eingabe oder belegtem Dokument")
        p.uhrzeit = None
        hinweis = "Die geplante Uhrzeit steht nicht in Eingabe oder belegtem Dokument; angezeigt ist der ganze Tag."
    return p, fundstellen, hinweis, zeitbezug


def ausfuehren(a: ExternAufruf, case: Case, eingabe: str = "", richter: bool = False) -> ExternAbruf:
    roh = {k: str(v) for k, v in a.parameter.items() if v not in (None, "")}
    try:
        p, fundstellen, hinweis, zeitbezug = pruefen(a, case, eingabe, richter)
    except Verworfen as e:
        return ExternAbruf(tool=a.tool, parameter=roh, status="verworfen", grund=str(e))
    gesendet = {k: str(v) for k, v in p.model_dump(exclude_none=True).items()}
    herkunft = "akte" if fundstellen else "eingabe"
    basis = dict(tool=a.tool, parameter=gesendet, fundstellen=fundstellen, herkunft=herkunft)
    try:
        aus = TOOLS[a.tool].fn(p, zeitbezug) if a.tool == "zeitzone" else TOOLS[a.tool].fn(p)
    except KeinErgebnis as e:
        return ExternAbruf(**basis, status="leer", grund=str(e))
    except (requests.RequestException, ValueError, KeyError) as e:
        log.warning("Externer Abruf %s fehlgeschlagen: %s", a.tool, e)
        return ExternAbruf(**basis, status="fehler", grund="Quelle nicht erreichbar oder Antwort nicht lesbar")
    return ExternAbruf(**basis, status="ok", werte=aus.werte, quelle=aus.quelle, url=aus.url,
                       abgerufen_am=aus.abgerufen_am, hinweis=" ".join(h for h in (hinweis, aus.hinweis) if h) or None)


# ---- Lauf --------------------------------------------------------------------

def _akteninhalt(case: Case) -> dict:
    """Akte für die Planung: Geschehen und Entitäten vollständig, Dokumenttext je Dokument gekürzt."""
    grenze = max(1500, config.FRAGE_VOLLTEXT_MAX // max(1, len(case.dokumente)))
    dokumente = []
    for d in case.dokumente:
        zeilen, summe = [], 0
        for l in d.text_lines:
            summe += len(l.text)
            if summe > grenze:
                break
            zeilen.append(f"{l.anchor} {l.text}")
        dokumente.append({"id": d.id, "titel": d.title, "zeilen": zeilen})
    texte = {l.anchor: l.text for d in case.dokumente for l in d.text_lines}
    return {
        "geschehen": [{"datum": e.ereignisdatum.iso if e.ereignisdatum else None, "beschreibung": e.beschreibung,
                       "stellen": [{"anker": f.line, "text": texte.get(f.line, "")} for f in e.fundstellen if f.line]}
                      for e in case.ereignisse if e.kind == "geschehen"],
        "entitaeten": [{"typ": e.typ, "label": e.label, "details": e.details, "anker": [f.line for f in e.fundstellen if f.line]}
                       for e in case.entitaeten if e.typ in ("website", "profil")],
        "dokumente": dokumente,
        "zeilen_mit_uhrzeit": [f"{l.anchor} {l.text}" for d in case.dokumente for l in d.text_lines
                              if re.search(r"\b\d{1,2}[:.]\d{2}\s*Uhr|\bOrtszeit\b", l.text, re.I)],
        "massenverfahren": {"sache": case.massenverfahren.sache,
                            "merkmale": [{"art": m.art, "wert": m.wert} for v in case.massenverfahren.verfahren for m in v.merkmale]}
                           if case.massenverfahren else None,
    }


def _schluessel(a: ExternAufruf) -> str:
    return json.dumps([a.tool.casefold(), {k: v.casefold() for k, v in a.parameter.items()
                                         if k != "land" and v not in (None, "")}], sort_keys=True)


def _gespeichert(case_id: str) -> dict:
    daten = store.get_extern(case_id)
    return daten if "berichte" in daten else {"berichte": []}


async def ideen(case_id: str) -> list[dict]:
    case = store.load_case(case_id)
    if not case:
        raise ValueError("Akte nicht gefunden")
    hashwert = hashlib.sha256((store.case_dir(case_id) / "case.json").read_bytes()).hexdigest()
    daten = _gespeichert(case_id)
    if daten.get("ideen_hash") == hashwert and daten.get("ideen_version") == 3:
        return daten.get("ideen", [])
    plan = await llm.ask(config.MODEL_CHAT, SYSTEM_EXTERN_IDEEN,
                         extern_ideen_prompt(_akteninhalt(case), {n: t.beschreibung for n, t in TOOLS.items()}),
                         ExternIdeen, effort=config.FRAGE_EFFORT)
    anker = {l.anchor for d in case.dokumente for l in d.text_lines}
    gruppen, anlaesse, gesehen = {}, {}, {}
    for idee in plan.ideen:
        if idee.art not in TOOLS or not idee.anlass.strip() or WERTUNG.search(idee.anlass):
            continue
        if not idee.anker or any(x not in anker for x in idee.anker):
            continue
        for abfrage in idee.abfragen:
            a = ExternAufruf(tool=idee.art, parameter=abfrage, anker=idee.anker)
            try:
                p, fundstellen, _, _ = pruefen(a, case)
            except Verworfen:
                continue
            a.parameter = p.model_dump(exclude_none=True)
            key = _schluessel(a)
            if idee.art not in gruppen:
                gruppen[idee.art] = {"art": idee.art, "anker": [], "abfragen": []}
                anlaesse[idee.art] = []
            gruppe = gruppen[idee.art]
            if key not in gesehen:
                if len(gruppe["abfragen"]) >= (MAX_ZEITZONEN if idee.art == "zeitzone" else 6):
                    continue
                gesehen[key] = {"parameter": a.parameter, "anker": []}
                gruppe["abfragen"].append(gesehen[key])
            for f in fundstellen:
                if f.line not in gesehen[key]["anker"]:
                    gesehen[key]["anker"].append(f.line)
                if f.line not in gruppe["anker"]:
                    gruppe["anker"].append(f.line)
            anlass = idee.anlass.strip()
            if anlass not in anlaesse[idee.art]:
                anlaesse[idee.art].append(anlass)
    ergebnis = [{"id": f"I{i}", **gruppe, "anlass": " ".join(anlaesse[art])}
                for i, (art, gruppe) in enumerate(list(gruppen.items())[:6], 1)]
    with _extern_lock:
        daten = _gespeichert(case_id)
        daten.update(ideen=ergebnis, ideen_hash=hashwert, ideen_version=3)
        store.set_extern(case_id, daten)
    return ergebnis


async def lauf(case_id: str, auswahl: list[ExternAufruf], anfrage: str, progress) -> None:
    case = store.load_case(case_id)
    if not case:
        raise ValueError("Akte nicht gefunden")
    abrufe, gesehen = [], set()
    anzahl = {False: 0, True: 0}

    async def abrufen(a: ExternAufruf, eingabe: str, richter: bool):
        key = _schluessel(a)
        if key in gesehen:
            return
        gesehen.add(key)
        zeitzonen = a.tool == "zeitzone"
        limit = MAX_ZEITZONEN if zeitzonen else MAX_ABRUFE
        if anzahl[zeitzonen] >= limit:
            abrufe.append(ExternAbruf(tool=a.tool, parameter={k: v for k, v in a.parameter.items() if v},
                                      status="verworfen", grund=f"Limit von {limit} {'Zeitzonen' if zeitzonen else 'Abrufen'} je Bericht erreicht"))
            return
        anzahl[zeitzonen] += 1
        progress(f"Abruf {sum(anzahl.values())}: {DATENART.get(a.tool, a.tool)}")
        abrufe.append(await asyncio.to_thread(ausfuehren, a, case, eingabe, richter))

    for a in auswahl:
        await abrufen(a, "", True)
    if anfrage.strip():
        progress("Angefragte Datenquellen planen …")
        plan = await llm.ask(config.MODEL_CHAT, SYSTEM_EXTERN_PLAN,
                             extern_plan_prompt(anfrage, _akteninhalt(case), {n: t.beschreibung for n, t in TOOLS.items()}),
                             ExternPlan, effort=config.FRAGE_EFFORT)
        for a in plan.aufrufe:
            await abrufen(a, anfrage, False)
    bericht = ExternBericht(id=uuid4().hex, erstellt_am=_jetzt(), abrufe=abrufe,
                            anfrage=anfrage if anfrage.strip() else "Auswahl: " + ", ".join(dict.fromkeys(DATENART.get(a.tool, a.tool) for a in auswahl)),
                            hinweis=None if abrufe else "Keine passende Quelle. Verfügbar sind: " + ", ".join(DATENART.values()))
    with _extern_lock:
        daten = _gespeichert(case_id)
        daten["berichte"].insert(0, bericht.model_dump())
        store.set_extern(case_id, daten)
    progress(f"{sum(r.status == 'ok' for r in abrufe)} Abrufe mit Ergebnis.")


def bericht_entfernen(case_id: str, bericht_id: str) -> bool:
    with _extern_lock:
        daten = _gespeichert(case_id)
        berichte = [b for b in daten["berichte"] if b.get("id") != bericht_id]
        if len(berichte) == len(daten["berichte"]):
            return False
        daten["berichte"] = berichte
        store.set_extern(case_id, daten)
    return True
