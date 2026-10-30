import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { api, type Case, type Marks } from './api'
import { useDocs } from './ctx'

const FMT: Record<string, string> = { pdf_text: 'PDF', pdf_image: 'PDF (Scan)', image: 'Bild' }

export function DocViewer({ data, docId, anchor, anchors, onClose }: { data: Case; docId: string; anchor?: string; anchors?: string[]; onClose: () => void }) {
  const { caseId } = useDocs()
  const doc = data.dokumente.find((d) => d.id === docId)
  const reps = (doc?.representations ?? []).filter((r) => r.format !== 'md')
  // Mit Original nur das Original; die Textansicht bleibt Dokumenten ohne Original
  const [gewaehlt, setGewaehlt] = useState<string | null>(null)
  const tab: string = reps.find((r) => r.format === gewaehlt)?.format ?? reps[0]?.format ?? 'text'
  const hasText = !!doc?.text_lines.length
  const [zoom, setZoom] = useState(false)

  const lines = anchors ?? (anchor ? [anchor] : [])
  const lineKey = JSON.stringify(lines)
  const requestKey = JSON.stringify([caseId, docId, lineKey, tab])
  const [result, setResult] = useState<{ key: string; marks?: Marks; error?: boolean } | null>(null)
  const current = result?.key === requestKey ? result : null
  const marks = current?.marks
  const marking = lines.length > 0 && tab !== 'text'

  useEffect(() => { setZoom(false) }, [caseId, docId, lineKey])
  useEffect(() => {
    const first = (JSON.parse(lineKey) as string[])[0]
    if (tab === 'text' && first) document.getElementById(`ln-${first}`)?.scrollIntoView({ block: 'center', behavior: 'instant' })
  }, [docId, lineKey, tab])
  useEffect(() => {
    if (!marking) return
    let stale = false
    setResult(null)
    api.marks(caseId, docId, JSON.parse(lineKey), tab).then((marks) => {
      if (!stale) setResult({ key: requestKey, marks })
    }).catch(() => { if (!stale) setResult({ key: requestKey, error: true }) })
    return () => { stale = true }
  }, [caseId, docId, lineKey, tab, marking, requestKey])

  if (!doc) return null
  const range = doc.blatt_von === doc.blatt_bis ? `${doc.blatt_von}` : `${doc.blatt_von}–${doc.blatt_bis}`
  const blatt = doc.aus_sammelakte ? (doc.blatt_hand ? `Bl. ${doc.blatt_hand} · S. ${range}` : `S. ${range}`) : `Bl. ${range}`
  const rep = reps.find((r) => r.format === tab)
  const src = api.fileUrl(caseId, doc.id, tab, lines) + (marks?.page ? `#page=${marks.page}` : '')

  return (
    <aside className="viewer" aria-label={`Aktenstück ${doc.id}`}>
      <header>
        <div className="top">
          <h2>{doc.id} · {doc.title || doc.doc_type}</h2>
          <button className="btn ghost" onClick={onClose} aria-label="Schließen"><X size={16} aria-hidden /></button>
        </div>
        <div className="meta">
          <span>{blatt}</span>
          {doc.doc_type && <span>{doc.doc_type}</span>}
          <span>Dokument: {doc.dokumentdatum?.anzeige ?? 'unklar'}</span>
          <span>Eingang: {doc.eingangsdatum?.anzeige ?? 'nicht angegeben'}</span>
        </div>
      </header>
      {reps.length > 1 && <div className="tabs" role="tablist">
        {reps.map((r) => (
          <button key={r.format} role="tab" className="tab" aria-selected={tab === r.format} onClick={() => setGewaehlt(r.format)}>
            {FMT[r.format]}
          </button>
        ))}
      </div>}
      {marking && <div className="mark-status" role="status">
        {!current && <span>Fundstellen werden markiert …</span>}
        {current?.error && <span>Fundstellen konnten nicht geladen werden. Bitte das Dokument schließen und erneut öffnen.</span>}
        {!!marks?.found.length && <span>{marks.found.length} Fundstelle(n) markiert</span>}
        {!!marks?.missing.length && <>
          <span>{marks.missing.length} Stelle(n) im Original nicht lokalisiert:</span>
          <ul className="mark-missing">
            {marks.missing.map((a) => {
              const text = doc.text_lines.find((l) => l.anchor === a)?.text
              return <li key={a}><b>{a}</b>{text ? ` „${text}“` : ''}</li>
            })}
          </ul>
        </>}
      </div>}
      <div className="body" style={tab !== 'text' && rep?.format !== 'image' ? { padding: 0 } : undefined}>
        {tab === 'text' && (hasText ? doc.text_lines.map((l, i) => (
          <div key={l.anchor}>
            {l.seite && l.seite !== doc.text_lines[i - 1]?.seite && (
              <div className="pagebreak">Seite {l.seite}{l.blatt ? ` · Bl. ${l.blatt}` : ''}</div>
            )}
            <div id={`ln-${l.anchor}`} className={`line ${lines.includes(l.anchor) ? 'hit' : ''}`}>
              <span className="a">{l.anchor.split(':')[1]}</span><span>{l.text}</span>
            </div>
          </div>
        )) : <p className="sub">Kein Text vorhanden.</p>)}
        {rep?.format === 'image' && (
          <button className={`original-image ${zoom ? 'zoom' : ''}`} onClick={() => setZoom(!zoom)} aria-label={zoom ? 'Bild verkleinern' : 'Bild vergrößern'} aria-pressed={zoom}>
            <img src={api.fileUrl(caseId, doc.id, 'image')} alt={`Original ${doc.id}`} />
            {marks?.boxes.filter((b) => b.page === 1).map((b, i) => <span key={i} className="image-mark" aria-hidden
              style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` }} />)}
          </button>
        )}
        {rep && rep.format !== 'image' && marking && !current && <div className="skelett skelett-dokument" />}
        {rep && rep.format !== 'image' && !(marking && !current) && <iframe title={`PDF ${doc.id}`} key={src} src={src} />}
      </div>
    </aside>
  )
}
