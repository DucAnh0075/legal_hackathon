import { useEffect, useState } from 'react'
import { api, type Case } from './api'
import { useDocs } from './ctx'

const FMT: Record<string, string> = { pdf_text: 'PDF', pdf_image: 'PDF (Scan)', image: 'Bild' }

export function DocViewer({ data, docId, anchor, onClose }: { data: Case; docId: string; anchor?: string; onClose: () => void }) {
  const { caseId } = useDocs()
  const doc = data.dokumente.find((d) => d.id === docId)
  const reps = (doc?.representations ?? []).filter((r) => r.format !== 'md')
  const hasText = !!doc?.text_lines.length
  const [tab, setTab] = useState<string>('text')
  const [zoom, setZoom] = useState(false)

  useEffect(() => { setTab(hasText ? 'text' : reps[0]?.format ?? 'text'); setZoom(false) }, [docId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (tab === 'text' && anchor) document.getElementById(`ln-${anchor}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [docId, anchor, tab])

  if (!doc) return null
  const range = doc.blatt_von === doc.blatt_bis ? `${doc.blatt_von}` : `${doc.blatt_von}–${doc.blatt_bis}`
  const blatt = doc.aus_sammelakte ? (doc.blatt_hand ? `Bl. ${doc.blatt_hand} · S. ${range}` : `S. ${range}`) : `Bl. ${range}`
  const rep = reps.find((r) => r.format === tab)

  return (
    <aside className="viewer" aria-label={`Aktenstück ${doc.id}`}>
      <header>
        <div className="top">
          <h2>{doc.id} · {doc.title || doc.doc_type}</h2>
          <button className="btn ghost" onClick={onClose} aria-label="Schließen">✕</button>
        </div>
        <div className="meta">
          <span>{blatt}</span>
          {doc.doc_type && <span>{doc.doc_type}</span>}
          <span>Dokument: {doc.dokumentdatum?.anzeige ?? 'unklar'}</span>
          <span>Eingang: {doc.eingangsdatum?.anzeige ?? 'nicht angegeben'}</span>
        </div>
      </header>
      <div className="tabs" role="tablist">
        {hasText && <button role="tab" className="tab" aria-selected={tab === 'text'} onClick={() => setTab('text')}>Text</button>}
        {reps.map((r) => (
          <button key={r.format} role="tab" className="tab" aria-selected={tab === r.format} onClick={() => setTab(r.format)}>
            Original · {FMT[r.format]}
          </button>
        ))}
      </div>
      <div className="body" style={tab !== 'text' && rep?.format !== 'image' ? { padding: 0 } : undefined}>
        {tab === 'text' && (hasText ? doc.text_lines.map((l, i) => (
          <div key={l.anchor}>
            {l.seite && l.seite !== doc.text_lines[i - 1]?.seite && (
              <div className="pagebreak">Seite {l.seite}{l.blatt ? ` · Bl. ${l.blatt}` : ''}</div>
            )}
            <div id={`ln-${l.anchor}`} className={`line ${l.anchor === anchor ? 'hit' : ''}`}>
              <span className="a">{l.anchor.split(':')[1]}</span><span>{l.text}</span>
            </div>
          </div>
        )) : <p className="sub">Kein Text vorhanden.</p>)}
        {rep?.format === 'image' && (
          <img src={api.fileUrl(caseId, doc.id, 'image')} alt={`Original ${doc.id}`} className={zoom ? 'zoom' : ''} onClick={() => setZoom(!zoom)} />
        )}
        {rep && rep.format !== 'image' && <iframe title={`PDF ${doc.id}`} src={api.fileUrl(caseId, doc.id, rep.format)} />}
      </div>
    </aside>
  )
}
