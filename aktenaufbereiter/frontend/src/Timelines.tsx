import { useMemo, useState } from 'react'
import { evDates, type Case, type DateValue, type Ev } from './api'
import { StatusChip, Page } from './components'
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
  const [ppd, setPpd] = useState(70)
  const rows = data.ereignisse.filter((e) => e.kind === 'verfahren').map((e) => ({ e, d: evDates(e, data.dokumente) }))
    .map((r) => ({ ...r, t: [ms(r.d.ereignis), ms(r.d.dokument), ms(r.d.eingang)] }))
    .filter((r) => r.t.some((x) => !isNaN(x)))
    .sort((a, b) => Math.min(...a.t.filter((x) => !isNaN(x))) - Math.min(...b.t.filter((x) => !isNaN(x))))
  const all = rows.flatMap((r) => r.t).filter((x) => !isNaN(x))
  const axis = useAxis(all.length ? all : [Date.now()], ppd)

  return (
    <Page title="Zeitleiste · Verfahren" sub="Ereignis, Dokument und Eingang getrennt" tools={<Zoom ppd={ppd} set={setPpd} />}>
      <div className="legend" style={{ marginBottom: 10 }}>
        <span><span className="mk e" style={{ position: 'static', transform: 'none', '--c': 'var(--s-aussage)' } as React.CSSProperties}><i /></span> Ereignisdatum</span>
        <span><span className="mk d" style={{ position: 'static', transform: 'none', '--c': 'var(--s-korrektur)' } as React.CSSProperties}><i /></span> Dokumentdatum</span>
        <span><span className="mk g" style={{ position: 'static', transform: 'none', '--c': 'var(--s-belegt)' } as React.CSSProperties}><i /></span> Eingangsdatum</span>
      </div>
      {rows.length === 0 ? <div className="empty">Keine datierten Verfahrensschritte.</div> : (
        <div className="tl" style={{ maxHeight: 'calc(100vh - 210px)' }}>
          <div style={{ width: axis.width + 300, minWidth: '100%' }}>
            <div style={{ display: 'flex', position: 'sticky', top: 0, zIndex: 6, background: 'var(--sunken)', borderBottom: '1px solid var(--line)' }}>
              <div className="lane-label" style={{ width: 300, borderBottom: 0 }}>Verfahrensschritt</div>
              <div style={{ position: 'relative', width: axis.width, height: 26 }}>
                {axis.ticks.map((t, i) => <div key={i} className="axis-tick" style={{ left: t.x, height: 26 }}><span>{t.label}</span></div>)}
              </div>
            </div>
            {rows.map(({ e, d, t }) => {
              const valid = t.filter((x) => !isNaN(x))
              const [a, b] = [Math.min(...valid), Math.max(...valid)]
              const mk = (v: number, cls: string, color: string, label: string) => isNaN(v) ? null : (
                <span key={cls} className={`mk ${cls}`} style={{ left: axis.x(v), '--c': color } as React.CSSProperties} title={label}><i /></span>
              )
              return (
                <div key={e.id} style={{ display: 'flex' }}>
                  <button className="lane-label" style={{ width: 300, textAlign: 'left', fontWeight: 400, cursor: 'pointer', height: 44, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', borderTop: 0, borderLeft: 0, color: 'inherit', font: 'inherit' }}
                    onClick={() => open(e.fundstellen[0]?.doc_id, e.fundstellen[0]?.line ?? undefined)} title={e.beschreibung}>
                    <b>{e.verfahrens_typ ?? 'Vorgang'}</b> · {e.beschreibung}
                  </button>
                  <div className="vrow" style={{ width: axis.width }}>
                    {axis.ticks.map((tk, i) => <div key={i} className="axis-tick" style={{ left: tk.x }} />)}
                    <div className="track" style={{ left: axis.x(a), width: axis.x(b) - axis.x(a) }} />
                    {mk(t[0], 'e', 'var(--s-aussage)', `Ereignis ${d.ereignis?.anzeige}`)}
                    {mk(t[1], 'd', 'var(--s-korrektur)', `Dokument ${d.dokument?.anzeige}`)}
                    {mk(t[2], 'g', 'var(--s-belegt)', `Eingang ${d.eingang?.anzeige}`)}
                    <span className="vlabel" style={{ left: axis.x(b) + 14 }}>{[d.ereignis, d.dokument, d.eingang].map((x) => x?.anzeige ?? '–').join(' · ')}</span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </Page>
  )
}
