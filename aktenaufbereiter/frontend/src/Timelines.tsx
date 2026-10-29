import { useMemo, useState } from 'react'
import { evDates, type Case, type DateValue, type Ev } from './api'
import { StatusChip, Page, FundChips } from './components'
import { useDocs } from './ctx'

const DAY = 86400000
const ms = (d?: DateValue | null) => (d?.iso ? Date.parse(d.iso) : NaN)
const LABEL_W = 150

function useAxis(times: number[], ppd: number) {
  const min = Math.min(...times) - 1.5 * DAY
  const max = Math.max(...times) + 2.5 * DAY
  const x = (t: number) => ((t - min) / DAY) * ppd + 12
  const width = Math.max(800, x(max) + 200)
  const step = ppd >= 40 ? 1 : ppd >= 10 ? 7 : 30
  const ticks: { x: number; label: string }[] = []
  for (let t = Math.floor(min / DAY / step) * step * DAY; t <= max; t += step * DAY) {
    const d = new Date(t)
    ticks.push({ x: x(t), label: d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', ...(step > 1 || d.getDate() === 1 ? { year: '2-digit' } : {}) }) })
  }
  return { x, width, ticks }
}

function Zoom({ ppd, set }: { ppd: number; set: (n: number) => void }) {
  return (
    <label className="legend">Zoom
      <input type="range" min={6} max={320} value={ppd} onChange={(e) => set(+e.target.value)} aria-label="Zeitleiste zoomen" />
    </label>
  )
}

const conflictKeys = (c: Case) => {
  const s = new Set<string>()
  c.widersprueche.forEach((w) => w.varianten.forEach((v) => v.fundstellen.forEach((f) => s.add(`${f.doc_id}:${f.line ?? ''}`))))
  return s
}

/** Zeitleiste 1: Geschehen. Spuren je erstem Beteiligten, Datum = Ereignisdatum. */
export function GeschehenTimeline({ data }: { data: Case }) {
  const { open } = useDocs()
  const [ppd, setPpd] = useState(70)
  const names = useMemo(() => new Map([...data.personen.map((p) => [p.id, p.name] as const), ...data.entitaeten.map((e) => [e.id, e.label] as const)]), [data])
  const conflicts = useMemo(() => conflictKeys(data), [data])
  const evs = data.ereignisse.filter((e) => e.kind === 'geschehen')
  const dated = evs.filter((e) => !isNaN(ms(e.ereignisdatum)))
  const undated = evs.filter((e) => isNaN(ms(e.ereignisdatum)))

  const laneOf = (e: Ev) => (e.beteiligte.find((b) => data.personen.some((p) => p.id === b)) ?? '')
  const laneIds = useMemo(() => {
    const count = new Map<string, number>()
    dated.forEach((e) => count.set(laneOf(e), (count.get(laneOf(e)) ?? 0) + 1))
    return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([id]) => id)
  }, [dated]) // eslint-disable-line react-hooks/exhaustive-deps

  const axis = useAxis(dated.length ? dated.map((e) => ms(e.ereignisdatum)) : [Date.now()], ppd)
  const lanes = [...laneIds, '__rest'].map((id) => {
    const list = dated.filter((e) => (laneIds.includes(laneOf(e)) ? laneOf(e) === id : id === '__rest')).sort((a, b) => ms(a.ereignisdatum) - ms(b.ereignisdatum))
    const ends: number[] = []
    const placed = list.map((e) => {
      const left = axis.x(ms(e.ereignisdatum))
      let r = ends.findIndex((end) => end + 8 <= left)
      if (r === -1) r = ends.length
      ends[r] = left + 190
      return { e, left, row: r }
    })
    return { id, placed, rows: Math.max(1, ends.length) }
  }).filter((l) => l.placed.length)

  return (
    <Page title="Zeitleiste · Geschehen" sub={`${dated.length} datierte Ereignisse`} tools={<Zoom ppd={ppd} set={setPpd} />}>
      <div className="legend" style={{ marginBottom: 10 }}>
        {(['belegt', 'aussage', 'korrektur', 'offen'] as const).map((s) => <StatusChip key={s} status={s} />)}
        <span><i className="dot" style={{ background: 'var(--thread)' }} /> in Widerspruch genannt</span>
      </div>
      {dated.length === 0 ? <div className="empty">Keine datierten Ereignisse.</div> : (
        <div className="tl" style={{ maxHeight: 'calc(100vh - 210px)' }}>
          <div style={{ width: axis.width + LABEL_W, minWidth: '100%' }}>
            <div style={{ display: 'flex', position: 'sticky', top: 0, zIndex: 6, background: 'var(--sunken)', borderBottom: '1px solid var(--line)' }}>
              <div className="lane-label" style={{ width: LABEL_W, borderBottom: 0 }}>Beteiligte</div>
              <div style={{ position: 'relative', width: axis.width, height: 26 }}>
                {axis.ticks.map((t, i) => <div key={i} className="axis-tick" style={{ left: t.x, height: 26 }}><span>{t.label}</span></div>)}
              </div>
            </div>
            {lanes.map((l) => (
              <div key={l.id} style={{ display: 'flex' }}>
                <div className="lane-label" style={{ width: LABEL_W }}>{l.id === '__rest' ? 'Weitere / ohne Person' : names.get(l.id) ?? l.id}</div>
                <div style={{ position: 'relative', width: axis.width, height: l.rows * 70 + 14, borderBottom: '1px solid var(--line)' }}>
                  {axis.ticks.map((t, i) => <div key={i} className="axis-tick" style={{ left: t.x }} />)}
                  {l.placed.map(({ e, left, row }) => {
                    const conflict = e.fundstellen.some((f) => conflicts.has(`${f.doc_id}:${f.line ?? ''}`))
                    return (
                      <button key={e.id} className={`ev s-${e.status} ${conflict ? 'conflict' : ''}`} style={{ left, top: 10 + row * 70 }}
                        onClick={() => open(e.fundstellen[0]?.doc_id, e.fundstellen[0]?.line ?? undefined)}
                        title={[e.ereignisdatum?.anzeige, e.ereignisdatum?.hinweis, e.beschreibung].filter(Boolean).join(' · ')}>
                        <span className="d">{e.ereignisdatum?.anzeige}{e.ereignisdatum?.hinweis ? ` · ${e.ereignisdatum.hinweis}` : ''}</span>
                        <span className="tx">{e.beschreibung}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {undated.length > 0 && (
        <section style={{ marginTop: 22 }}>
          <h3 style={{ fontSize: 16, marginBottom: 8 }}>Ohne verwertbares Datum</h3>
          <div style={{ display: 'grid', gap: 6, maxWidth: 760 }}>
            {undated.map((e) => (
              <button key={e.id} className="caserow" onClick={() => open(e.fundstellen[0]?.doc_id, e.fundstellen[0]?.line ?? undefined)}>
                <StatusChip status={e.status} /> {e.beschreibung} <span className="stats">{e.ereignisdatum?.hinweis ?? 'Datum unklar'}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </Page>
  )
}

/** Zeitleiste 2: Verfahren. Je Vorgang drei Marker: Ereignis, Dokument, Eingang. */
export function VerfahrenTimeline({ data }: { data: Case }) {
  const { open } = useDocs()
  const rows = data.ereignisse.filter((e) => e.kind === 'verfahren').map((e) => {
    const d = evDates(e, data.dokumente)
    return { e, d, t: Math.min(...Object.values(d).map(ms).filter(Number.isFinite)) }
  }).sort((a, b) => a.t - b.t)
  const dated = rows.filter((r) => Number.isFinite(r.t))
  const undated = rows.filter((r) => !Number.isFinite(r.t))
  const kinds = [ ['ereignis', 'Ereignis', 'aussage'], ['dokument', 'Dokument', 'korrektur'], ['eingang', 'Eingang', 'belegt'] ] as const
  const month = (t: number) => new Date(t).toLocaleDateString('de-DE', { month: 'long', year: 'numeric', timeZone: 'UTC' })
  const card = ({ e, d }: typeof rows[number]) => (
    <article className="verfahren-card" onClick={() => { const f = e.fundstellen[0]; if (f) open(f.doc_id, f.line ?? undefined) }}>
      <button className="verfahren-open" disabled={!e.fundstellen.length}><b>{e.verfahrens_typ || 'Vorgang'}</b> · {e.beschreibung}</button>
      <div className="verfahren-dates">
        {kinds.map(([key, label, color]) => <span key={key} className={`date-chip s-${color}`} title={d[key]?.hinweis ?? undefined}>
          <span><i className="dot" /> <b>{label}</b> {d[key]?.anzeige || d[key]?.iso || '–'}</span>
          {d[key]?.hinweis && <small>{d[key].hinweis}</small>}
        </span>)}
      </div>
      <div className="verfahren-fund" onClick={(e) => e.stopPropagation()}><FundChips items={e.fundstellen} /></div>
    </article>
  )
  return (
    <Page title="Zeitleiste · Verfahren" sub={`${dated.length} datierte Verfahrensschritte`}>
      <div className="legend">
        {kinds.map(([, label, color]) => <span key={label}><i className={`dot s-${color}`} style={{ background: 'var(--c)' }} />{label === 'Eingang' ? 'Eingangs' : label}datum</span>)}
      </div>
      <div className="verfahren-strang">
        {!dated.length && <div className="empty">Keine datierten Verfahrensschritte.</div>}
        {dated.map((r, i) => {
          const prev = dated[i - 1]
          const days = prev ? Math.floor((r.t - prev.t) / DAY) : 0
          return <div key={r.e.id}>
            {days > 7 && <div className="verfahren-gap">{days} Tage</div>}
            {(!prev || month(prev.t) !== month(r.t)) && <h3 className="verfahren-month">{month(r.t)}</h3>}
            <div className="verfahren-station">{card(r)}</div>
          </div>
        })}
        {!!undated.length && <section><h3 className="verfahren-month">Ohne verwertbares Datum</h3>
          {undated.map((r) => <div className="verfahren-station" key={r.e.id}>{card(r)}</div>)}
        </section>}
      </div>
    </Page>
  )
}
