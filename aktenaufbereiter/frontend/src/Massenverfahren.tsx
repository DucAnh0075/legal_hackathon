import { useState } from 'react'
import { api, type Fundstelle, type Massenverfahren as MassenverfahrenData } from './api'
import { Page } from './components'
import type { JobState } from './Start'

const fundstelle = (f: Fundstelle) => `${f.line?.includes(':') ? f.line : f.line ? `${f.doc_id}:${f.line}` : f.doc_id}${f.unklar ? ' (Fundstelle unklar)' : ''}`

export function Massenverfahren({ mv, onOpen, job, onStart }: {
  mv: MassenverfahrenData; onOpen: (id: string) => void; job: JobState | null
  onStart: (jobId: string, caseId: string, open?: boolean) => void
}) {
  const [pending, setPending] = useState(false)
  const [startError, setStartError] = useState('')
  const busy = pending || !!job?.busy
  const error = startError || job?.error || ''
  const log = job?.log ?? []
  const create = async () => {
    setPending(true); setStartError('')
    try {
      const { job, case_id } = await api.createSammelakte(mv.id)
      onStart(job, case_id)
    } catch (err) { setStartError(String(err)) }
    finally { setPending(false) }
  }

  return (
    <Page title={`Massenverfahren in Sache ${mv.sache}`} sub={`${mv.mitglieder.length} Akten · sortiert nach Eingang der Klage`}>
      {mv.gemeinsamkeiten.length > 0 && <section className="mv-common">
        <h2>Gemeinsamkeiten</h2>
        <ul>{mv.gemeinsamkeiten.map((g, i) => <li key={i}>{g}</li>)}</ul>
      </section>}
      <div className="tablewrap">
        <table className="t mv-table" aria-label="Einzelakten des Massenverfahrens">
          <thead><tr>{['Nr.', 'Eingang', 'Akte', 'Aktivseite', 'Gegenseite', 'Merkmale'].map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>
          <tbody>{mv.mitglieder.map((m, i) => (
            <tr key={m.case_id}>
              <td>{i + 1}</td>
              <td>{m.klageeingang?.anzeige || 'Eingang nicht ausgewiesen'}
                {m.klageeingang?.hinweis && <small className="sub">{m.klageeingang.hinweis}</small>}
                {m.klageeingang_fundstelle && <small className="sub">{fundstelle(m.klageeingang_fundstelle)}</small>}
              </td>
              <td><button className="text-link" onClick={() => onOpen(m.case_id)}>{m.name}</button>
                {mv.neue_mitglieder.includes(m.case_id) && <small className="sub">neu – noch nicht in der Sammelakte</small>}
              </td>
              <td>{m.aktivseite.length ? m.aktivseite.map((p, j) => <div key={j}>{p}</div>) : '—'}</td>
              <td>{m.gegenseite.length ? m.gegenseite.map((p, j) => <div key={j}>{p}</div>) : '—'}</td>
              <td>{m.merkmale.length ? m.merkmale.map((merkmal, j) => <div key={j} className="merkmal">
                {merkmal.art}: {merkmal.wert}
                {merkmal.fundstellen.length > 0 && <small className="sub">{merkmal.fundstellen.map(fundstelle).join(' · ')}</small>}
              </div>) : '—'}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <p className="sub">Die Sammelakte führt alle Einzelverfahren in einer Akte zusammen (Verzeichnisse, Zeitleisten, Widersprüche, Beweisboard). Die Einzelakten bleiben unverändert.</p>
      <div className="mv-actions">
        {mv.sammelakte_id ? <>
          <button className="btn primary" disabled={busy} onClick={() => onOpen(mv.sammelakte_id!)}>Sammelakte öffnen</button>
          {mv.neue_mitglieder.length > 0 && <button className="btn" disabled={busy} onClick={create}>Sammelakte ergänzen ({mv.neue_mitglieder.length} neu)</button>}
        </> : <button className="btn primary" disabled={busy} onClick={create}>Sammelakte erstellen</button>}
      </div>
      {(busy || log.length > 0 || error) && <div className="log" role="log" aria-live="polite">
        {busy && log.length === 0 && <div>Agent startet …</div>}
        {log.map((l, i) => <div key={i}>{l}</div>)}
        {error && <div className="err">Fehler: {error}</div>}
      </div>}
    </Page>
  )
}
