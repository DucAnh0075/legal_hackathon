import type { Case } from './api'
import { FundChips, Page } from './components'

const MONATE = 'Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember'
const WERT = new RegExp(`\\d{4}-\\d{2}-\\d{2}|\\d{1,2}\\.\\d{1,2}\\.(?:\\d{2,4})?|\\d{1,2}\\.\\s?(?:${MONATE})(?:\\s\\d{4})?|\\d{1,2}:\\d{2}(?:\\s?Uhr)?|\\d{1,3}(?:\\.\\d{3})*(?:,\\d+)?\\s?(?:Euro|EUR|€)`, 'g')
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '')

/** Unterstreicht in jeder Variante gleich die Daten und Beträge, die nicht in allen Varianten stehen. */
function Behauptung({ text, alle }: { text: string; alle: string[] }) {
  const teile: React.ReactNode[] = []
  let pos = 0
  for (const m of text.matchAll(WERT)) {
    if (alle.every((t) => (t.match(WERT) ?? []).some((w) => norm(w) === norm(m[0])))) continue
    teile.push(text.slice(pos, m.index), <mark key={m.index} className="abweichung">{m[0]}</mark>)
    pos = m.index + m[0].length
  }
  teile.push(text.slice(pos))
  return <div>{teile}</div>
}

export function Contradictions({ data }: { data: Case }) {
  const who = new Map([...data.personen.map((p) => [p.id, p.name] as const), ...data.entitaeten.map((e) => [e.id, e.label] as const)])
  return (
    <Page title="Widersprüche" sub={`${data.widersprueche.length} Abweichungen, jeweils alle Varianten mit Fundstelle; abweichende Daten und Beträge sind unterstrichen`}>
      {data.widersprueche.length === 0 ? <div className="empty">Keine Widersprüche dokumentiert.</div> : (
        <div className="contras">
          {data.widersprueche.map((w) => (
            <article key={w.id} className="contra">
              <h3>{w.thema}</h3>
              <div className="variants" style={{ '--spalten': w.varianten.length === 4 ? 2 : Math.min(w.varianten.length, 3) } as React.CSSProperties}>
                {w.varianten.map((v, i) => (
                  <div key={i} className="variant">
                    <Behauptung text={v.behauptung} alle={w.varianten.map((x) => x.behauptung)} />
                    {v.quelle_person && <div className="who">{who.get(v.quelle_person) ?? v.quelle_person}</div>}
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}><FundChips items={v.fundstellen} /></div>
                  </div>
                ))}
              </div>
              {w.hinweis && <p className="sub" style={{ margin: '10px 0 0' }}>{w.hinweis}</p>}
            </article>
          ))}
        </div>
      )}
    </Page>
  )
}
