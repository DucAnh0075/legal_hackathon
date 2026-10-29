import type { Case } from './api'
import { FundChips, Page } from './components'

export function Contradictions({ data }: { data: Case }) {
  const who = new Map(data.personen.map((p) => [p.id, p.name]))
  return (
    <Page title="Widersprüche" sub={`${data.widersprueche.length} Abweichungen, jeweils alle Varianten mit Fundstelle`}>
      {data.widersprueche.length === 0 ? <div className="empty">Keine Widersprüche dokumentiert.</div> : (
        <div className="contras">
          {data.widersprueche.map((w) => (
            <article key={w.id} className="contra">
              <h3>{w.thema}</h3>
              <div className="variants">
                {w.varianten.map((v, i) => (
                  <div key={i} className="variant">
                    <div>{v.behauptung}</div>
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
