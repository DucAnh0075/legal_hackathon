import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type AktenAntwort, type Datei, type FragenEvent, type Hinweis, type Kontext, type Treffer } from './api'
import { Page } from './components'

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

export function Fragen({ scope, caseName, canScopeCase, onScope, fragen, onOpen }: {
  scope: string | null; caseName?: string; canScopeCase: boolean; onScope: (caseScope: boolean) => void
  fragen: ReturnType<typeof useFragen>; onOpen: (caseId: string, docId: string, anchors: string[]) => void
}) {
  const [entwuerfe, setEntwuerfe] = useState<Record<string, string>>({})
  const key = scopeKey(scope)
  const text = entwuerfe[key] ?? ''
  const items = fragen.verlauf[key] ?? []
  const busy = items.some((e) => e.busy)
  const submit = () => {
    if (busy || !text.trim()) return
    void fragen.stellen(text, scope)
    setEntwuerfe((d) => ({ ...d, [key]: '' }))
  }
  return <Page title={scope === null ? 'Fragen an alle Akten' : 'Fragen an die Akte'} sub={scope === null ? undefined : caseName}>
    <div className="frage-inhalt">
      {canScopeCase && <div className="frage-actions" aria-label="Fragebereich">
        <button className="btn" aria-pressed={scope !== null} onClick={() => onScope(true)}>Diese Akte</button>
        <button className="btn" aria-pressed={scope === null} onClick={() => onScope(false)}>Alle Akten</button>
      </div>}
      <form className="frage-form" onSubmit={(e) => { e.preventDefault(); submit() }}>
        <label htmlFor="aktenfrage">Frage an die Akten</label>
        <textarea id="aktenfrage" rows={3} value={text} disabled={busy} aria-describedby="frage-hilfe" onChange={(e) => setEntwuerfe((d) => ({ ...d, [key]: e.target.value }))}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit() } }} />
        <div><button className="btn primary" disabled={busy || !text.trim()}>Fragen</button></div>
        <p id="frage-hilfe" className="frage-meta">Antworten stammen nur aus den Akten und tragen Fundstellen. Keine rechtliche Bewertung.</p>
      </form>
      {[...items].reverse().map((e) => {
        const dateien = passendeDateien(e)
        const dauer = Math.max(0, ...Object.values(e.ms))
        return <section className="frage-eintrag" key={e.id} aria-labelledby={`frage-${e.id}`}>
          <h2 id={`frage-${e.id}`}>{e.frage}</h2>
          {dateien.length > 0 && <div className="frage-dateien">
            <h3>{e.antwort ? 'Passende Dateien' : 'Mögliche Treffer'}</h3>
            {dateien.map((d) => <button className="frage-datei" key={JSON.stringify([d.case_id, d.doc_id])} onClick={() => onOpen(d.case_id, d.doc_id, d.anchors)}>
              <span>{d.title || d.doc_id}</span><span className="frage-meta">{[d.blatt && blattText(d.blatt), scope === null && d.case_name, `${d.anchors.length} ${d.anchors.length === 1 ? 'Stelle' : 'Stellen'}`].filter(Boolean).join(' · ')}</span>
            </button>)}
          </div>}
          {e.busy && <p className="frage-meta" role="status">Antwort wird aus der Akte erstellt …</p>}
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
          {!!e.antwort?.nachfragen.length && <div className="frage-actions">{e.antwort.nachfragen.map((f, i) => <button className="btn" key={i} disabled={busy} onClick={() => void fragen.stellen(f, scope)}>{f}</button>)}</div>}
          {e.error && <p className="err" role="alert">{e.error}</p>}
        </section>
      })}
    </div>
  </Page>
}
