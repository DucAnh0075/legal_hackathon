import { useRef, useState } from 'react'
import type { CaseInfo } from './api'
import { api } from './api'
import { Page } from './components'

export type JobState = { caseId: string; log: string[]; busy: boolean; error: string; started: number }

export function Start({ cases, onOpen, job, onStart }: {
  cases: CaseInfo[]; onOpen: (id: string) => void; job: JobState | null; onStart: (jobId: string, caseId: string) => void
}) {
  const [caseId, setCaseId] = useState('')
  const [name, setName] = useState('')
  const [folder, setFolder] = useState('')
  const files = useRef<HTMLInputElement>(null)
  const [startError, setStartError] = useState('')
  const busy = !!job?.busy
  const log = job?.log ?? []
  const error = startError || job?.error || ''

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setStartError('')
    const f = new FormData()
    f.set('case_id', caseId.trim()); if (name) f.set('name', name)
    if (folder.trim()) f.set('folder', folder.trim())
    Array.from(files.current?.files ?? []).forEach((x) => f.append('files', x))
    try {
      const { job } = await api.create(f)
      onStart(job, caseId.trim())
    } catch (err) { setStartError(String(err)) }
  }

  return (
    <Page title="Aktenaufbereiter" sub="Akten einlesen, sortieren, Verzeichnisse und Beweisboard erzeugen">
      {cases.length > 0 && (
        <section className="cases">
          <h2 style={{ fontSize: 18, marginBottom: 4 }}>Bearbeitete Akten</h2>
          {cases.map((c) => (
            <button key={c.id} className="caserow" onClick={() => onOpen(c.id)}>
              <b>{c.name}</b>
              <span className="stats"><span>{c.dokumente} Aktenstücke</span><span>{c.personen} Personen</span><span>{c.widersprueche} Widersprüche</span></span>
            </button>
          ))}
        </section>
      )}
      <h2 style={{ fontSize: 18, marginBottom: 10 }}>Neue Akte oder Ergänzung</h2>
      <form className="form" onSubmit={submit}>
        <label>Kennung (Buchstaben, Ziffern, Bindestrich). Bestehende Kennung = Ergänzung, Vorhandenes bleibt unverändert.
          <input type="text" required pattern="[A-Za-z0-9_\-]+" value={caseId} onChange={(e) => setCaseId(e.target.value)} placeholder="nordstern" />
        </label>
        <label>Bezeichnung <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Nordstern-Deal" /></label>
        <label>Ordnerpfad auf dem Server <input type="text" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="/pfad/zur/akte" /></label>
        <label>oder Dateien hochladen (PDF, Markdown, Bilder). Eine mehrseitige Sammel-PDF wird automatisch in Aktenstücke gegliedert. <input type="file" ref={files} multiple accept=".pdf,.md,.png,.jpg,.jpeg,.webp" /></label>
        <div><button className="btn primary" disabled={busy}>{busy ? <><i className="spinner" aria-hidden /> Agent arbeitet …</> : 'Akte aufbereiten'}</button></div>
      </form>
      {(log.length > 0 || error) && (
        <div className="log" role="log" aria-live="polite">
          {log.map((l, i) => <div key={i}>{l}</div>)}
          {error && <div className="err">Fehler: {error}</div>}
        </div>
      )}
    </Page>
  )
}
