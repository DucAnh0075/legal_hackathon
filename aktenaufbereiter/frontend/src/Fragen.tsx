import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type AktenAntwort, type Datei, type FragenEvent, type Hinweis, type Kontext, type Treffer } from './api'

export type Eintrag = {
  id: string; frage: string; treffer: Treffer[]; kontext: Kontext | null; antwort: AktenAntwort | null
  dateien: Datei[]; hinweise: Hinweis[]; pruefung: 'laeuft' | 'fertig' | 'fehler' | 'keine'
  ms: Record<string, number>; aus_cache: boolean; busy: boolean; error: string
}
const scopeKey = (scope: string | null) => scope ?? '__pool'

export function useFragen() {
  const [verlauf, setVerlauf] = useState<Record<string, Eintrag[]>>({})
  const entries = useRef(verlauf)
  const streams = useRef(new Map<string, EventSource>())
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    const sources = streams.current
    return () => { mounted.current = false; sources.forEach((s) => s.close()); sources.clear() }
  }, [])
  const update = useCallback((key: string, change: (items: Eintrag[]) => Eintrag[]) => {
    if (!mounted.current) return
    entries.current = { ...entries.current, [key]: change(entries.current[key] ?? []) }
    setVerlauf(entries.current)
  }, [])
  const stellen = useCallback(async (frage: string, scope: string | null) => {
    frage = frage.trim()
    const key = scopeKey(scope)
    const bisher = entries.current[key] ?? []
    if (!frage || bisher.some((e) => e.busy)) return
    const id = crypto.randomUUID()
    const history = bisher.filter((e) => !e.busy && !e.error && e.antwort).slice(-3)
      .map((e) => ({ frage: e.frage, antwort: e.antwort!.aussagen.map((a) => a.text).join('\n') }))
    update(key, (items) => [...items, { id, frage, treffer: [], kontext: null, antwort: null, dateien: [], hinweise: [], pruefung: 'keine', ms: {}, aus_cache: false, busy: true, error: '' }])
    const patch = (change: (e: Eintrag) => Eintrag) => update(key, (items) => items.map((e) => e.id === id ? change(e) : e))
    const finish = (error = '') => {
      streams.current.get(id)?.close(); streams.current.delete(id)
      patch((e) => ({ ...e, busy: false, error: error || e.error, pruefung: e.pruefung === 'laeuft' ? 'fehler' : e.pruefung }))
    }
    try {
      const { job } = await api.frage(frage, scope, history)
      if (!mounted.current) return
      const es = new EventSource(`/api/jobs/${encodeURIComponent(job)}/events`)
      streams.current.set(id, es)
      es.onmessage = (message) => {
        try {
          const ev = JSON.parse(message.data) as FragenEvent
          patch((entry) => {
            const e = { ...entry, ms: { ...entry.ms } }
            for (const name of ['treffer', 'kontext', 'antwort', 'pruefung', 'msg', 'done', 'error'] as const) {
              if (name in ev && Number.isFinite(ev.ms)) e.ms[name] = ev.ms
            }
            if (ev.treffer) e.treffer = ev.treffer
            if (ev.kontext) e.kontext = ev.kontext
            if (ev.antwort) {
              e.antwort = ev.antwort; e.dateien = ev.dateien ?? []; e.hinweise = ev.hinweise ?? []
              e.aus_cache = !!ev.aus_cache
              e.pruefung = ev.antwort.aussagen.length ? (ev.aus_cache ? 'fertig' : 'laeuft') : 'keine'
            }
            if ('pruefung' in ev) {
              e.pruefung = ev.pruefung === null || ev.pruef_fehler ? 'fehler' : 'fertig'
              if (e.antwort && ev.pruefung) {
                const checks = ev.pruefung
                e.antwort = { ...e.antwort, aussagen: e.antwort.aussagen.map((a, index) => {
                  const check = checks.find((p) => p.index === index)
                  return check ? { ...a, urteil: check.urteil, grund: check.grund } : a
                }) }
              }
            }
            if (ev.pruef_fehler) e.pruefung = 'fehler'
            return e
          })
          if (ev.error) finish(ev.error)
          else if (ev.done) finish()
        } catch { finish('Die Antwort konnte nicht gelesen werden.') }
      }
      es.onerror = () => finish('Verbindung zur Aktenbefragung unterbrochen.')
    } catch (error) { finish(error instanceof Error ? error.message : String(error)) }
  }, [update])
  return { verlauf, stellen }
}

function passendeDateien(e: Eintrag): Datei[] {
  if (e.antwort) return e.dateien
  const grouped = new Map<string, Datei>()
  for (const t of e.treffer) {
    const key = JSON.stringify([t.case_id, t.doc_id])
    const d = grouped.get(key)
    if (d) { if (!d.anchors.includes(t.anchor)) d.anchors.push(t.anchor) }
    else grouped.set(key, { case_id: t.case_id, case_name: t.case_name, doc_id: t.doc_id, title: t.doc_title, blatt: t.blatt, anchors: [t.anchor] })
  }
  return [...grouped.values()]
}
const statusText = {
  beantwortet: '', teilweise: 'Die Akte beantwortet die Frage nur teilweise.', nicht_in_akte: 'In der Akte nicht beantwortet.',
  ausserhalb: 'Außerhalb des Aktenaufbereiters: keine Wertung und keine rechtliche Einschätzung.',
}
const urteilText = { traegt: 'Beleg trägt die Aussage', traegt_teilweise: 'Beleg trägt nur teilweise', traegt_nicht: 'Beleg trägt die Aussage nicht' }
const bezugText = { stuetzt: 'stützt', widerspricht: 'widerspricht', erwaehnt: 'erwähnt' }
const blattText = (blatt: string) => /^\d/.test(blatt) ? `Bl. ${blatt}` : blatt

export function FragenFenster({ scope, caseName, hatAkte, onBereich, fragen, onOpen, dokumentOffen, offen, onOffen, vollbild, onVollbild }: {
  scope: string | null; caseName?: string; hatAkte: boolean; onBereich: (bereich: 'akte' | 'alle') => void
  fragen: ReturnType<typeof useFragen>; onOpen: (caseId: string, docId: string, anchors: string[]) => void
  dokumentOffen: boolean; offen: boolean; onOffen: (offen: boolean) => void
  vollbild: boolean; onVollbild: (vollbild: boolean) => void
}) {
  const [entwuerfe, setEntwuerfe] = useState<Record<string, string>>({})
  const [gesehen, setGesehen] = useState(0)
  const icon = useRef<HTMLButtonElement>(null)
  const fenster = useRef<HTMLElement>(null)
  const eingabe = useRef<HTMLTextAreaElement>(null)
  const verlauf = useRef<HTMLDivElement>(null)
  const folgen = useRef(true) // zeigt die neueste Frage, bis der Nutzer selbst scrollt
  const scrollTop = useRef(0)
  const warOffen = useRef(false)
  const key = scopeKey(scope)
  const text = entwuerfe[key] ?? ''
  const items = fragen.verlauf[key]
  const busy = items?.some((e) => e.busy) ?? false
  const alle = Object.values(fragen.verlauf).flat()
  const laeuft = alle.some((e) => e.busy)
  const fertig = alle.filter((e) => !e.busy).length
  const titel = scope === null ? 'Fragen an alle Akten' : 'Fragen an die Akte'
  useEffect(() => { if (offen) setGesehen(fertig) }, [offen, fertig])
  useEffect(() => {
    if (offen) eingabe.current?.focus()
    else if (warOffen.current) icon.current?.focus()
    warOffen.current = offen
  }, [offen])
  useEffect(() => {
    if (!offen) return
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || (!vollbild && !fenster.current?.contains(document.activeElement))) return
      event.preventDefault()
      if (vollbild) onVollbild(false)
      else onOffen(false)
    }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [offen, vollbild, onOffen, onVollbild])
  useEffect(() => { folgen.current = true }, [key])
  useEffect(() => {
    const el = verlauf.current
    if (!offen || !el) return
    const neueste = el.querySelector<HTMLElement>('.frage-eintrag:last-child')
    el.scrollTop = folgen.current ? (neueste?.offsetTop ?? 0) : scrollTop.current
  }, [items, offen, key, vollbild])
  const stellen = (frage: string) => {
    if (busy || !frage.trim()) return
    folgen.current = true
    void fragen.stellen(frage, scope)
  }
  const submit = () => {
    if (busy || !text.trim()) return
    stellen(text)
    setEntwuerfe((d) => ({ ...d, [key]: '' }))
  }
  const vorschlaege = scope !== null
    ? ['Worum geht es in dieser Akte?', 'Welche Fristen und Termine sind dokumentiert?', 'Wo weichen Angaben voneinander ab?']
    : ['Welche Akten betreffen dieselbe Gegenseite?', 'Welche Fristen sind dokumentiert?', 'In welchen Akten wird ein Rückruf erwähnt?']
  return <>
    <button ref={icon} className={`frage-icon${dokumentOffen ? ' mit-dokument' : ''}`} hidden={offen}
      aria-label="Fragen an die Akten" title="Fragen an die Akten" aria-expanded={offen} onClick={() => onOffen(true)}>
      {laeuft ? <i className="spinner" aria-hidden="true" /> : <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 4V6a2 2 0 0 1 2-2Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /></svg>}
      {fertig > gesehen && <span className="frage-icon-punkt" aria-hidden="true" />}
    </button>
    <section ref={fenster} className={`frage-fenster${vollbild ? ' vollbild' : ''}${dokumentOffen ? ' mit-dokument' : ''}`}
      hidden={!offen} role="dialog" aria-modal="false" aria-label={titel}>
      <header className="frage-kopf">
        <div className="frage-titel"><h2>{titel}</h2>{scope !== null && <small className="sub">{caseName}</small>}</div>
        <div className="frage-kopf-knopfe">
          <button className="btn ghost frage-vollbild" aria-pressed={vollbild} aria-label={vollbild ? 'Vollbild beenden' : 'Vollbild'} onClick={() => onVollbild(!vollbild)}>
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d={vollbild ? 'M3 9h6V3m6 0v6h6M3 15h6v6m6 0v-6h6' : 'M9 3H3v6m12-6h6v6M3 15v6h6m6 0h6v-6'} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
          <button className="btn ghost" aria-label="Schließen" onClick={() => onOffen(false)}>
            <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          </button>
        </div>
        {hatAkte && <div className="frage-actions" aria-label="Fragebereich">
          <button className="btn" aria-pressed={scope !== null} onClick={() => onBereich('akte')}>Diese Akte</button>
          <button className="btn" aria-pressed={scope === null} onClick={() => onBereich('alle')}>Alle Akten</button>
        </div>}
      </header>
      <div className="frage-verlauf" ref={verlauf} aria-live="polite" tabIndex={0}
        onWheel={() => { folgen.current = false }} onTouchMove={() => { folgen.current = false }}
        onKeyDown={(e) => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) folgen.current = false }}
        onScroll={(e) => { if (e.currentTarget.clientHeight) scrollTop.current = e.currentTarget.scrollTop }}>
        <div className="frage-inhalt">
          {!items?.length && <div className="frage-leer"><p>Antworten stammen nur aus den Akten und tragen Fundstellen. Keine rechtliche Bewertung.</p>
            <div className="frage-actions">{vorschlaege.map((frage) => <button className="btn" key={frage} onClick={() => stellen(frage)}>{frage}</button>)}</div>
          </div>}
      {items?.map((e) => {
        const dateien = passendeDateien(e)
        const dauer = Math.max(0, ...Object.values(e.ms))
        return <section className="frage-eintrag" key={e.id} aria-labelledby={`frage-${e.id}`}>
          <p className="frage-blase" id={`frage-${e.id}`}>{e.frage}</p>
          {e.busy && <p className="frage-meta" role="status">Antwort wird aus der Akte erstellt …</p>}
          {!e.antwort && dateien.length > 0 && <div className="frage-dateien">
            <h3>Mögliche Treffer</h3>
            {dateien.map((d) => <button className="frage-datei" key={JSON.stringify([d.case_id, d.doc_id])} onClick={() => onOpen(d.case_id, d.doc_id, d.anchors)}>
              <span>{d.title || d.doc_id}</span><span className="frage-meta">{[d.blatt && blattText(d.blatt), scope === null && d.case_name, `${d.anchors.length} ${d.anchors.length === 1 ? 'Stelle' : 'Stellen'}`].filter(Boolean).join(' · ')}</span>
            </button>)}
          </div>}
          {e.antwort && statusText[e.antwort.status] && <p>{statusText[e.antwort.status]}</p>}
          {e.antwort?.aussagen.map((a, i) => <div className="frage-aussage" key={i}>
            <p>{a.text}</p>
            {a.belege.map((b, j) => <blockquote className="frage-beleg" key={j}>
              <p>{b.zitat}</p>
              <div className="frage-actions"><small className="sub">{bezugText[b.bezug]}</small>
                <button className="chip link" onClick={() => onOpen(b.case_id, b.doc_id, [b.line])}>{b.blatt ? `${blattText(b.blatt)} · ` : ''}{b.line}</button>
              </div>
            </blockquote>)}
            <div className={`frage-urteil ${a.urteil === 'traegt_nicht' ? 'frage-warn' : ''}`}>
              {a.urteil ? urteilText[a.urteil] : e.pruefung === 'laeuft' ? 'wird geprüft' : 'Belegprüfung nicht verfügbar'}
              {a.grund && <span> · {a.grund}</span>}
            </div>
          </div>)}
          {e.antwort && dateien.length > 0 && <div className="frage-dateien">
            <h3>Passende Dateien</h3>
            {dateien.map((d) => <button className="frage-datei" key={JSON.stringify([d.case_id, d.doc_id])} onClick={() => onOpen(d.case_id, d.doc_id, d.anchors)}>
              <span>{d.title || d.doc_id}</span><span className="frage-meta">{[d.blatt && blattText(d.blatt), scope === null && d.case_name, `${d.anchors.length} ${d.anchors.length === 1 ? 'Stelle' : 'Stellen'}`].filter(Boolean).join(' · ')}</span>
            </button>)}
          </div>}
          {e.pruefung === 'fehler' && <p className="err">Die Belegprüfung konnte nicht abgeschlossen werden.</p>}
          {e.hinweise.length > 0 && <div className="frage-hinweise"><h3>Dazu in der Akte dokumentiert</h3>
            {e.hinweise.map((h) => <button className="frage-datei" key={`${h.case_id}:${h.art}:${h.id}`} disabled={!h.anchors.length}
              onClick={() => { const anchor = h.anchors[0]; if (anchor) onOpen(h.case_id, anchor.split(':')[0], [anchor]) }}>
              <span><b>{h.art === 'frist' ? 'Frist' : 'Widerspruch'}</b> · {h.text}</span>
            </button>)}
          </div>}
          <div className="frage-meta">
            {e.kontext && <p>{e.kontext.art === 'suche' ? `Durchsucht: ${e.kontext.stellen} Stellen aus ${e.kontext.dokumente} von ${e.kontext.dokumente_gesamt} Dokumenten; nicht die gesamte Akte.` : 'Gesamter Text ausgewertet.'}</p>}
            {!!e.antwort?.verworfen && <p>{e.antwort.verworfen} Angaben ohne prüfbaren Beleg wurden verworfen.</p>}
            {!e.busy && Object.keys(e.ms).length > 0 && <p>Dauer: {(dauer / 1000).toLocaleString('de', { maximumFractionDigits: 1 })} s{e.aus_cache ? ' · aus dem Zwischenspeicher' : ''}</p>}
          </div>
          {e.error && <p className="err" role="alert">{e.error}</p>}
          {!!e.antwort?.nachfragen.length && <div className="frage-actions">{e.antwort.nachfragen.map((f, i) => <button className="btn" key={i} disabled={busy} onClick={() => stellen(f)}>{f}</button>)}</div>}
        </section>
      })}
        </div>
      </div>
      <form className="frage-eingabe" onSubmit={(e) => { e.preventDefault(); submit() }}>
        <textarea ref={eingabe} aria-label="Frage an die Akten" placeholder="Frage an die Akte stellen" rows={2} value={text}
          onChange={(e) => setEntwuerfe((d) => ({ ...d, [key]: e.target.value }))}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit() } }} />
        <button className="btn primary" disabled={busy || !text.trim()}>Fragen</button>
      </form>
    </section>
  </>
}
