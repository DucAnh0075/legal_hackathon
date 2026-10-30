import { useEffect, useMemo, useRef, useState } from 'react'
import type { Pool } from './api'
import { api } from './api'
import { Fold, Page } from './components'
import { aktenZiel, mvZiel, type LoeschZiel } from './LoeschMenu'

export type JobState = { caseId: string; log: string[]; busy: boolean; error: string; started: number }

/** Kennung aus der Bezeichnung: nur Zeichen, die das Backend als Akten-ID annimmt. */
function kennungAus(name: string, vergeben: Map<string, string>) {
  const basis = name.trim().toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (!basis || !vergeben.has(basis)) return basis
  let n = 2
  while (vergeben.has(`${basis}-${n}`)) n++
  return `${basis}-${n}`
}

function AkteZeile({ name, stats, onOpen, onErgaenzen, onContextMenu }: { onContextMenu: React.MouseEventHandler<HTMLDivElement>; name: string; stats?: string[]; onOpen: () => void; onErgaenzen: () => void }) {
  return (
    <div className="caseitem" tabIndex={-1} onContextMenu={onContextMenu}>
      <button className="caserow" onClick={onOpen}>
        <b>{name}</b>
        {stats && <span className="stats">{stats.map((s) => <span key={s}>{s}</span>)}</span>}
      </button>
      <button className="btn ghost" aria-label={`${name} ergänzen`} onClick={onErgaenzen}>Ergänzen</button>
    </div>
  )
}

export function Start({ pool, onMassenverfahren, onOpen, job, onStart, onMenu }: {
  onMenu: (e: React.MouseEvent, ziel: LoeschZiel) => void;
  pool: Pool | null; onMassenverfahren: (id: string) => void; onOpen: (id: string) => void; job: JobState | null; onStart: (jobId: string, caseId: string, open?: boolean) => void
}) {
  const [name, setName] = useState('')
  const [kennung, setKennung] = useState<string | null>(null)
  const [folder, setFolder] = useState('')
  const [ziel, setZiel] = useState<{ id: string; name: string } | null>(null)
  const files = useRef<HTMLInputElement>(null)
  const zielPanel = useRef<HTMLFormElement>(null)
  const [startError, setStartError] = useState('')
  const [pending, setPending] = useState(false)
  const busy = pending || !!job?.busy
  const cases = pool?.einzel ?? []

  const bekannt = useMemo(() => {
    const m = new Map<string, string>()
    cases.forEach((c) => m.set(c.id, c.name))
    pool?.massenverfahren.forEach((g) => {
      g.mitglieder.forEach((x) => m.set(x.case_id, x.name))
      if (g.sammelakte_id) m.set(g.sammelakte_id, `Sammelakte ${g.sache}`)
    })
    return m
  }, [cases, pool])
  useEffect(() => {
    if (pool && ziel && !bekannt.has(ziel.id)) setZiel(null)
  }, [pool, ziel, bekannt])
  const caseId = kennung ?? kennungAus(name, bekannt)
  const vorhanden = kennung !== null ? bekannt.get(kennung.trim()) : undefined

  useEffect(() => {
    if (!ziel) return
    zielPanel.current?.scrollIntoView({ block: 'nearest' })
    zielPanel.current?.querySelector('input')?.focus()
  }, [ziel])

  const refreshPool = async () => {
    setPending(true); setStartError('')
    try {
      const { job } = await api.refreshPool()
      onStart(job, '', false)
    } catch (err) { setStartError(String(err)) }
    finally { setPending(false) }
  }
  const log = job?.log ?? []
  const error = startError || job?.error || ''

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setStartError('')
    const id = (ziel?.id ?? caseId).trim()
    const dateien = Array.from(files.current?.files ?? [])
    if (!folder.trim() && !dateien.length) { setStartError('Ordnerpfad angeben oder Dateien auswählen.'); return }
    const f = new FormData()
    f.set('case_id', id)
    // Bei einer Ergänzung bleibt die bestehende Bezeichnung erhalten
    if (name.trim() && !bekannt.has(id)) f.set('name', name.trim())
    if (folder.trim()) f.set('folder', folder.trim())
    dateien.forEach((x) => f.append('files', x))
    try {
      const { job } = await api.create(f)
      onStart(job, id)
      setZiel(null)
    } catch (err) { setStartError(String(err)) }
  }

  const quellen = <>
    <label>Ordnerpfad auf dem Server <input type="text" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="/pfad/zur/akte" /></label>
    <label>oder Dateien hochladen (PDF, Markdown, Bilder). Eine mehrseitige Sammel-PDF wird automatisch in Aktenstücke gegliedert. <input type="file" ref={files} multiple accept=".pdf,.md,.png,.jpg,.jpeg,.webp" /></label>
  </>
  const absenden = (label: string) => <button className="btn primary" disabled={busy}>{busy ? <><i className="spinner" aria-hidden /> Agent arbeitet …</> : label}</button>

  return (
    <Page title="Aktenaufbereiter" sub="Akten einlesen, sortieren, Verzeichnisse und Beweisboard erzeugen">
      {pool && <>
        {cases.length > 0 && (
          <Fold id="aktenpool" className="section" title={<h2>Aktenpool<span className="count">{cases.length}</span></h2>}>
            {cases.map((c) => (
              <AkteZeile onContextMenu={(e) => onMenu(e, aktenZiel(c.id, c.name))} key={c.id} name={c.name} onOpen={() => onOpen(c.id)} onErgaenzen={() => setZiel({ id: c.id, name: c.name })}
                stats={[`${c.dokumente} Aktenstücke`, `${c.personen} Personen`, `${c.widersprueche} Widersprüche`]} />
            ))}
          </Fold>
        )}
        <Fold id="massenverfahren" className="section" title={<h2>Massenverfahren<span className="count">{pool.massenverfahren.length}</span></h2>}
          action={<button className="btn" disabled={busy} onClick={refreshPool}>Pool neu prüfen</button>}>
          {pool.massenverfahren.length === 0 && <p className="sub">Keine Massenverfahren erkannt.</p>}
          {pool.massenverfahren.map((m) => (
            <Fold onContextMenu={(e) => onMenu(e, mvZiel(m))} key={m.id} id={`mv:${m.id}`} defaultOpen={false} className="mv-fold" title={<>
              <b>{m.sache}</b>
              <span className="stats">
                <span>{m.mitglieder.length} Akten</span>
                {m.neue_mitglieder.length > 0 && <span className="neu">{m.neue_mitglieder.length} neu, noch nicht in der Sammelakte</span>}
                {m.sammelakte_id && <span>Sammelakte vorhanden</span>}
              </span>
            </>}>
              {m.mitglieder.map((a) => (
                <div key={a.case_id} className="member" tabIndex={-1} onContextMenu={(e) => onMenu(e, aktenZiel(a.case_id, a.name))}>
                  <button className="text-link" onClick={() => onOpen(a.case_id)}>{a.name}</button>
                  {m.neue_mitglieder.includes(a.case_id) && <small className="sub">neu, noch nicht in der Sammelakte</small>}
                  <button className="btn ghost" aria-label={`${a.name} ergänzen`} onClick={() => setZiel({ id: a.case_id, name: a.name })}>Ergänzen</button>
                </div>
              ))}
              <div className="member-foot"><button className="btn" onClick={() => onMassenverfahren(m.id)}>Massenverfahren öffnen</button></div>
            </Fold>
          ))}
        </Fold>
        {ziel ? (
          <form className="form ergaenzung" ref={zielPanel} onSubmit={submit}>
            <h2>Ergänzung zu „{ziel.name}“</h2>
            <p className="sub">Neue Aktenstücke werden hinzugefügt, Vorhandenes bleibt unverändert.</p>
            {quellen}
            <div className="form-actions">
              {absenden('Akte ergänzen')}
              <button type="button" className="btn" onClick={() => setZiel(null)}>Abbrechen</button>
            </div>
          </form>
        ) : (
          <Fold id="neue-akte" defaultOpen={cases.length === 0 && pool.massenverfahren.length === 0} className="section" title={<h2>Neue Akte</h2>}>
            <form className="form" onSubmit={submit}>
              <label>Bezeichnung <input type="text" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Nordstern-Deal" /></label>
              {quellen}
              <label>Kennung (wird aus der Bezeichnung erzeugt, änderbar)
                <input type="text" required pattern="[A-Za-z0-9_\-]+" value={caseId} onChange={(e) => setKennung(e.target.value)} placeholder="nordstern-deal" />
                {vorhanden && <span className="hint">Kennung vorhanden: Akte „{vorhanden}“ wird ergänzt.</span>}
              </label>
              <div>{absenden('Akte aufbereiten')}</div>
            </form>
          </Fold>
        )}
      </>}
      {(log.length > 0 || error) && (
        <div className="log" role="log" aria-live="polite">
          {log.map((l, i) => <div key={i}>{l}</div>)}
          {error && <div className="err">Fehler: {error}</div>}
        </div>
      )}
    </Page>
  )
}
