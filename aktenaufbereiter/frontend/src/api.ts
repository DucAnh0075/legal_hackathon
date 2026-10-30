export type DateValue = { iso?: string | null; anzeige?: string | null; precision: string; hinweis?: string | null }
export type Fundstelle = { doc_id: string; line?: string | null; blatt?: string | null; unklar: boolean }
export type TextLine = { anchor: string; text: string; seite?: number | null; blatt?: string | null }
export type Representation = { format: 'md' | 'pdf_text' | 'pdf_image' | 'image'; path: string; sorted_path?: string | null }
export type Doc = {
  id: string; title: string; doc_type: string; format: Representation['format']; representations: Representation[]
  blatt_von?: number | null; blatt_bis?: number | null; dokumentdatum?: DateValue | null; eingangsdatum?: DateValue | null
  quelle_akte?: string | null; essentialia: string; text_lines: TextLine[]; aus_sammelakte?: boolean; blatt_hand?: string | null
}
export type Person = { id: string; name: string; aliases: string[]; adresse: string; rollen: string[]; fundstellen: Fundstelle[] }
export type Entity = { id: string; typ: string; label: string; details?: string | null; fundstellen: Fundstelle[] }
export type Ev = {
  id: string; kind: 'geschehen' | 'verfahren'; verfahrens_typ?: string | null
  ereignisdatum?: DateValue | null; dokumentdatum?: DateValue | null; eingangsdatum?: DateValue | null
  beschreibung: string; beteiligte: string[]; status: 'belegt' | 'aussage' | 'korrektur' | 'offen'; fundstellen: Fundstelle[]
}
export type Variante = { behauptung: string; quelle_person?: string | null; fundstellen: Fundstelle[] }
export type Contradiction = { id: string; thema: string; varianten: Variante[]; hinweis?: string | null }
export type Relation = { id: string; von: string; beziehung: string; zu: string; bemerkung?: string | null; fundstellen: Fundstelle[] }
export type Tatkomplex = { id: string; label: string; vorwurf_laut_akte: string; zeitraum: string; personen: string[]; beweismittel: string[] }
export type FristTermin = { id: string; art: string; datum?: DateValue | null; beschreibung: string; fundstellen: Fundstelle[] }
export type OffeneFrage = { id: string; frage: string; fundstellen: Fundstelle[] }
export type Merkmal = { art: string; wert: string; fundstellen: Fundstelle[] }
export type Mitglied = { case_id: string; name: string; klageeingang?: DateValue | null; klageeingang_fundstelle?: Fundstelle | null; aktivseite: string[]; gegenseite: string[]; merkmale: Merkmal[] }
export type Massenverfahren = { id: string; sache: string; gemeinsamkeiten: string[]; mitglieder: Mitglied[]; sammelakte_id: string | null; neue_mitglieder: string[] }
export type Pool = { einzel: CaseInfo[]; massenverfahren: Massenverfahren[] }
export type Einzelverfahren = Mitglied & { buchstabe: string }
export type MassenverfahrenInfo = { mv_id: string; sache: string; gemeinsamkeiten: string[]; verfahren: Einzelverfahren[] }
export type Case = {
  massenverfahren?: MassenverfahrenInfo | null;
  id: string; name: string; dokumente: Doc[]; personen: Person[]; entitaeten: Entity[]; ereignisse: Ev[]
  widersprueche: Contradiction[]; beziehungen: Relation[]; tatkomplexe: Tatkomplex[]; fristen: FristTermin[]; offene_fragen: OffeneFrage[]; warnungen: string[]
}
export type Table = { title: string; cols: string[]; rows: { id: string; doc: string | null; cells: (string | number)[] }[] }
export type BoardRolle = { id: string; rolle: string }
export type BoardSeite = { bezeichnung: string; haupt: string[]; vertreter: BoardRolle[]; zeugen: BoardRolle[] }
export type BoardBeweis = { person: string; doc_id: string | null; bezeichnung: string; fundstellen: Fundstelle[] }
export type BoardStruktur = { verfahrensart: 'zivil' | 'straf'; aktiv: BoardSeite; passiv: BoardSeite; weitere: BoardRolle[]; beweismittel: BoardBeweis[] }
export type CaseData = { case: Case; board?: BoardStruktur; suspects: Record<string, boolean>; tables: Record<string, Table>; layout: Record<string, unknown> }
export type Marks = { fmt: string; page: number | null; boxes: { page: number; x: number; y: number; w: number; h: number }[]; found: string[]; missing: string[] }
export type CaseInfo = { sammelakte?: boolean; id: string; name: string; dokumente: number; personen: number; widersprueche: number }

export type Treffer = { case_id: string; case_name: string; doc_id: string; doc_title: string; blatt: string; anchor: string; text: string }
export type Kontext = { art: 'volltext' | 'suche'; zeichen: number; stellen: number; dokumente: number; dokumente_gesamt: number }
export type Beleg = { case_id: string; doc_id: string; line: string; zitat: string; bezug: 'stuetzt' | 'widerspricht' | 'erwaehnt'; blatt?: string | null }
export type Urteil = 'traegt' | 'traegt_teilweise' | 'traegt_nicht'
export type Aussage = { text: string; belege: Beleg[]; urteil?: Urteil | null; grund?: string | null }
export type AktenAntwort = { status: 'beantwortet' | 'teilweise' | 'nicht_in_akte' | 'ausserhalb'; aussagen: Aussage[]; nachfragen: string[]; verworfen: number }
export type Datei = { case_id: string; case_name: string; doc_id: string; title: string; blatt: string; anchors: string[] }
export type Hinweis = { art: 'widerspruch' | 'frist'; case_id: string; id: string; text: string; anchors: string[] }
export type FragenEvent = {
  ms: number; treffer?: Treffer[]; kontext?: Kontext; antwort?: AktenAntwort; dateien?: Datei[]; hinweise?: Hinweis[]; aus_cache?: boolean
  pruefung?: { index: number; urteil: Urteil; grund: string }[] | null; pruef_fehler?: string; msg?: string; done?: boolean; error?: string
}

export type ExternWert = { label: string; wert: string; link?: string | null }
export type ExternIdee = { id: string; art: string; anlass: string; anker: string[]; abfragen: { parameter: Record<string, string>; anker: string[] }[] }
export type ExternAbruf = {
  tool: string; parameter: Record<string, string>; status: 'ok' | 'leer' | 'fehler' | 'verworfen'; grund?: string | null
  fundstellen: Fundstelle[]; herkunft: 'akte' | 'eingabe'; werte: ExternWert[]; quelle?: string | null; url?: string | null; abgerufen_am?: string | null; hinweis?: string | null
}
export type ExternBericht = { id: string; anfrage: string; erstellt_am: string; abrufe: ExternAbruf[]; hinweis?: string | null }
export type ExternStand = { berichte: ExternBericht[]; laeuft: boolean }

const j = async <T,>(r: Response): Promise<T> => {
  if (!r.ok) throw new Error((await r.text()) || r.statusText)
  return r.json()
}
const geloescht = async (r: Response): Promise<{ ok: boolean }> => {
  if (!r.ok) {
    const fehler = await r.json().catch(() => null)
    throw new Error(typeof fehler?.detail === 'string' ? fehler.detail : r.statusText)
  }
  return r.json()
}
export const api = {
  deleteCase: (id: string) => fetch(`/api/cases/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(geloescht),
  deleteMv: (id: string) => fetch(`/api/pool/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(geloescht),
  frage: (frage: string, caseId: string | null, verlauf: { frage: string; antwort: string }[]) =>
    fetch('/api/fragen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ frage, case_id: caseId, verlauf }) }).then((r) => j<{ job: string }>(r)),
  pool: () => fetch('/api/pool').then((r) => j<Pool>(r)),
  refreshPool: () => fetch('/api/pool/refresh', { method: 'POST' }).then((r) => j<{ job: string }>(r)),
  createSammelakte: (mvId: string) => fetch(`/api/pool/${encodeURIComponent(mvId)}/sammelakte`, { method: 'POST' }).then((r) => j<{ job: string; case_id: string }>(r)),
  cases: () => fetch('/api/cases').then((r) => j<CaseInfo[]>(r)),
  get: (id: string) => fetch(`/api/cases/${id}`).then((r) => j<CaseData>(r)),
  annotate: (id: string, row: string, field: 'kanzlei' | 'mandant', value: string) =>
    fetch(`/api/cases/${id}/annotations/${row}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ field, value }) }),
  saveLayout: (id: string, layout: unknown) =>
    fetch(`/api/cases/${id}/board-layout`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(layout) }),
  saveSuspects: (id: string, map: Record<string, boolean>) =>
    fetch(`/api/cases/${id}/suspects`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(map) }).then(async (r) => {
      if (!r.ok) throw new Error((await r.text()) || r.statusText)
    }),
  marks: (id: string, doc: string, lines: string[], fmt?: string) =>
    fetch(`/api/cases/${id}/marks/${doc}?${new URLSearchParams({ lines: lines.join(','), ...(fmt ? { fmt } : {}) })}`).then((r) => j<Marks>(r)),
  create: (form: FormData) => fetch('/api/cases', { method: 'POST', body: form }).then((r) => j<{ job: string }>(r)),
  fileUrl: (id: string, doc: string, fmt?: string, mark?: string[]) => {
    const q = new URLSearchParams({ ...(fmt ? { fmt } : {}), ...(mark?.length ? { mark: mark.join(',') } : {}) }).toString()
    return `/api/cases/${id}/files/${doc}${q ? `?${q}` : ''}`
  },
  xlsxUrl: (id: string) => `/api/cases/${id}/export.xlsx`,
  extern: (id: string) => fetch(`/api/cases/${id}/extern`).then((r) => j<ExternStand>(r)),
  externIdeen: (id: string) => fetch(`/api/cases/${id}/extern/ideen`).then((r) => j<{ ideen: ExternIdee[] }>(r)),
  externAbruf: (id: string, auswahl: { tool: string; parameter: Record<string, string>; anker: string[] }[], anfrage: string) =>
    fetch(`/api/cases/${id}/extern/abruf`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ auswahl, anfrage }) }).then((r) => j<{ job: string }>(r)),
  externEntfernen: (id: string, berichtId: string) => fetch(`/api/cases/${id}/extern/${encodeURIComponent(berichtId)}`, { method: 'DELETE' }).then((r) => j<unknown>(r)),
}

export const evDates = (e: Ev, docs: Doc[]) => {
  const d = docs.find((x) => x.id === e.fundstellen[0]?.doc_id)
  return {
    ereignis: e.ereignisdatum ?? null,
    dokument: e.dokumentdatum ?? d?.dokumentdatum ?? null,
    eingang: e.eingangsdatum ?? d?.eingangsdatum ?? null,
  }
}
