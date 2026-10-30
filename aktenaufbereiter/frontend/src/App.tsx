import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, type CaseData, type Pool } from './api'
import { Massenverfahren } from './Massenverfahren'
import { Board } from './Board'
import { Fold } from './components'
import { Contradictions } from './Contradictions'
import { DataTable } from './DataTable'
import { DocViewer } from './DocViewer'
import { Fragen, useFragen } from './Fragen'
import { DocCtx, type OpenDoc } from './ctx'
import { Start, type JobState } from './Start'
import { GeschehenTimeline, VerfahrenTimeline } from './Timelines'

type View = 'fragen' | 'mv' | 'einzelverfahren' | 'start' | 'akte' | 'personen' | 'tatkomplexe' | 'beziehungen' | 'fristen' | 'widersprueche' | 'geschehen' | 'verfahren' | 'board'

const NAV: { group: string; items: { id: View; label: string; count?: (d: CaseData) => number }[] }[] = [
  { group: 'Verzeichnisse', items: [
    { id: 'akte', label: 'Aktenübersicht', count: (d) => d.case.dokumente.length },
    { id: 'personen', label: 'Personen', count: (d) => d.case.personen.length },
    { id: 'tatkomplexe', label: 'Tatkomplexe', count: (d) => d.case.tatkomplexe.length },
    { id: 'beziehungen', label: 'Beziehungen', count: (d) => d.tables.beziehungen.rows.length },
    { id: 'fristen', label: 'Fristen & Termine', count: (d) => d.case.fristen.length },
  ] },
  { group: 'Zeitleisten', items: [
    { id: 'geschehen', label: 'Geschehen', count: (d) => d.case.ereignisse.filter((e) => e.kind === 'geschehen').length },
    { id: 'verfahren', label: 'Verfahren', count: (d) => d.case.ereignisse.filter((e) => e.kind === 'verfahren').length },
  ] },
  { group: 'Analyse', items: [
    { id: 'board', label: 'Beweisboard' },
    { id: 'widersprueche', label: 'Widersprüche', count: (d) => d.case.widersprueche.length },
  ] },
]

type Notice = { text: string; warn?: boolean; mvId?: string; retry?: boolean }

const mitgliedIds = (p: Pool) => new Set(p.massenverfahren.flatMap((m) => m.mitglieder.map((a) => a.case_id)))

/** Meldung nach einem Lauf: wohin die Akte gehört, oder was die Pool-Prüfung ergeben hat. */
function zuordnung(id: string, p: Pool, vorher: Pool | null, log: string[]): Notice {
  if (!id) {
    const uebersprungen = log.filter((l) => /^Profil .+ übersprungen/.test(l)).length
    const alt = vorher ? mitgliedIds(vorher) : null
    const neu = alt ? [...mitgliedIds(p)].filter((x) => !alt.has(x)).length : 0
    return {
      text: `Pool geprüft: ${p.massenverfahren.length} Massenverfahren, ${neu === 0 ? 'keine Akte' : neu === 1 ? '1 Akte' : `${neu} Akten`} neu zugeordnet.`
        + (uebersprungen ? ` ${uebersprungen === 1 ? '1 Akte konnte' : `${uebersprungen} Akten konnten`} nicht geprüft werden.` : ''),
      warn: uebersprungen > 0,
    }
  }
  const treffer = p.massenverfahren.find((m) => m.mitglieder.some((a) => a.case_id === id))
  const name = treffer?.mitglieder.find((a) => a.case_id === id)?.name ?? p.einzel.find((c) => c.id === id)?.name ?? id
  if (log.some((l) => l.startsWith('Pool-Prüfung fehlgeschlagen') || l.startsWith(`Profil ${id} übersprungen`))) {
    return { text: `„${name}“ wurde aufbereitet, die Zuordnung konnte nicht geprüft werden.`, warn: true, retry: true }
  }
  if (!treffer) return { text: `„${name}“ steht als Einzelakte im Aktenpool. Kein Massenverfahren erkannt.` }
  const bisher = vorher?.massenverfahren.some((m) => m.id === treffer.id && m.mitglieder.some((a) => a.case_id === id))
  const offen = treffer.sammelakte_id && treffer.neue_mitglieder.includes(id) ? ' Noch nicht in der Sammelakte.' : ''
  return {
    text: `„${name}“ ${bisher ? 'gehört zum' : 'wurde dem'} Massenverfahren in Sache „${treffer.sache}“${bisher ? '' : ' zugeordnet'} (${treffer.mitglieder.length} Akten).${offen}`,
    mvId: treffer.id,
  }
}

export default function App() {
  const [pool, setPool] = useState<Pool | null>(null)
  const poolRef = useRef<Pool | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [mvId, setMvId] = useState<string | null>(null)
  const [caseId, setCaseId] = useState<string | null>(null)
  const [data, setData] = useState<CaseData | null>(null)
  const [view, setView] = useState<View>('start')
  const [fragenScope, setFragenScope] = useState<string | null>(null)
  const fragen = useFragen()
  const [doc, setDoc] = useState<{ id: string; anchor?: string; anchors?: string[] } | null>(null)
  const [dark, setDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches)
  const [job, setJob] = useState<JobState | null>(null)
  const [now, setNow] = useState(Date.now())
  const [suche, setSuche] = useState('')

  useEffect(() => {
    if (!job?.busy) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [job?.busy])

  useEffect(() => { document.documentElement.dataset.theme = dark ? 'dark' : 'light' }, [dark])
  const refresh = useCallback(() => Promise.all([
    api.cases().catch(() => []),
    api.pool().then(setPool).catch(() => setPool({ einzel: [], massenverfahren: [] })),
  ]), [])
  useEffect(() => { refresh() }, [refresh])
  useEffect(() => { poolRef.current = pool }, [pool])

  const load = useCallback(async (id: string, v: View = 'akte', preserveView = false) => {
    const next = await api.get(id)
    setData(next); setCaseId(id)
    if (!preserveView) { setView(v); setDoc(null) }
    refresh()
  }, [refresh])

  const openIn = async (id: string, docId: string, anchors: string[]) => {
    try {
      if (id !== caseId) await load(id, 'fragen', true)
      setDoc({ id: docId, anchors })
    } catch (error) { setNotice({ text: `Akte konnte nicht geöffnet werden: ${error}`, warn: true }) }
  }
  const openFragen = (scope: string | null) => { setFragenScope(scope); setView('fragen'); setDoc(null) }

  // Agentenlauf: Fortschritt per SSE, unabhängig von der gerade offenen Ansicht
  const startJob = useCallback((jobId: string, id: string, open = true) => {
    setJob({ caseId: id, log: [], busy: true, error: '', started: Date.now() })
    setNotice(null)
    const vorher = poolRef.current
    const log: string[] = []
    const es = new EventSource(`/api/jobs/${jobId}/events`)
    es.onmessage = (m) => {
      const ev = JSON.parse(m.data)
      if (ev.msg) { log.push(ev.msg); setJob((j) => j && { ...j, log: [...j.log, ev.msg] }) }
      if (ev.error) { es.close(); setJob((j) => j && { ...j, busy: false, error: ev.error }); refresh() }
      if (ev.done) {
        es.close(); setJob((j) => j && { ...j, busy: false })
        if (id.startsWith('sammel-')) refresh()
        else api.pool()
          .then((p) => { setPool(p); setNotice(zuordnung(id, p, vorher, log)) })
          .catch(() => setNotice({ text: 'Die Zuordnung konnte nicht geprüft werden.', warn: true, retry: true }))
        if (open) load(id).catch((err) => setJob((j) => j && { ...j, error: String(err) }))
      }
    }
    es.onerror = () => { es.close(); setJob((j) => j && { ...j, busy: false, error: j.error || 'Verbindung zum Agenten unterbrochen.' }); refresh() }
  }, [load, refresh])

  const ctx = useMemo(() => ({ open: ((id, anchor, opts) => { if (id) setDoc({ id, anchor, ...opts }) }) as OpenDoc, caseId: caseId ?? '' }), [caseId])
  const t = data?.tables
  const mv = pool?.massenverfahren.find((m) => m.id === mvId)
  const woerter = suche.toLocaleLowerCase('de').split(/\s+/).filter(Boolean)
  const filtert = woerter.length > 0
  const trifft = (...felder: string[]) => {
    const text = felder.join(' ').toLocaleLowerCase('de')
    return woerter.every((w) => text.includes(w))
  }
  const einzel = (pool?.einzel ?? []).filter((c) => trifft(c.name, c.id))
  const gruppen = (pool?.massenverfahren ?? []).filter((m) => trifft(m.sache, ...m.mitglieder.map((a) => a.name)))
  const openMv = (id: string) => { setMvId(id); setView('mv'); setDoc(null) }
  const poolPruefen = async () => {
    try {
      const { job } = await api.refreshPool()
      startJob(job, '', false)
    } catch (err) { setNotice({ text: `Pool-Prüfung nicht gestartet: ${err}`, warn: true, retry: true }) }
  }

  return (
    <DocCtx.Provider value={ctx}>
      <div className={`app ${doc && data ? 'with-doc' : ''}`}>
        <nav className="side" aria-label="Navigation">
          <div className="brand">Aktenaufbereiter</div>
          <div className="casename">{data?.case.name ?? 'Keine Akte geöffnet'}</div>
          <button className="nav" aria-current={view === 'start' ? 'page' : undefined} onClick={() => { setView('start'); setDoc(null) }}>Übersicht</button>
          <input type="search" className="side-search" aria-label="Akten filtern" placeholder="Akten filtern" value={suche} onChange={(e) => setSuche(e.target.value)} />
          <Fold id="side:aktenpool" forceOpen={filtert} className="side-fold frage-pool-nav" title={<>Aktenpool<span className="n">{einzel.length}</span></>}>
              <button className="nav" aria-current={view === 'fragen' && fragenScope === null ? 'page' : undefined} onClick={() => openFragen(null)}>Fragen an alle Akten</button>
              {einzel.map((c) => (
                <button key={c.id} className="nav" title={c.name} aria-current={view !== 'start' && view !== 'mv' && view !== 'fragen' && caseId === c.id ? 'page' : undefined} onClick={() => load(c.id)}>
                  <span className="nav-label">{c.name}</span>
                </button>
              ))}
          </Fold>
          {gruppen.length > 0 && (
            <Fold id="side:massenverfahren" forceOpen={filtert} className="side-fold" title={<>Massenverfahren<span className="n">{gruppen.length}</span></>}>
              {gruppen.map((m) => (
                <button key={m.id} className="nav" title={`Massenverfahren in Sache ${m.sache}`} aria-current={view === 'mv' && mvId === m.id ? 'page' : undefined} onClick={() => openMv(m.id)}>
                  <span className="nav-label">{m.sache}</span><span className="n">{m.mitglieder.length}</span>
                </button>
              ))}
            </Fold>
          )}
          {filtert && !einzel.length && !gruppen.length && <p className="side-empty">Keine Treffer</p>}
          {data && NAV.map((g) => (
            <div key={g.group} style={{ display: 'contents' }}>
              <div className="nav-group">{g.group}</div>
              {g.group === 'Verzeichnisse' && data.case.massenverfahren && (
                <button className="nav" aria-current={view === 'einzelverfahren' ? 'page' : undefined} onClick={() => setView('einzelverfahren')}>
                  Einzelverfahren<span className="n">{data.case.massenverfahren.verfahren.length}</span>
                </button>
              )}
              {g.group === 'Analyse' && <button className="nav" aria-current={view === 'fragen' && fragenScope === caseId ? 'page' : undefined} onClick={() => openFragen(caseId)}>Fragen an diese Akte</button>}
              {g.items.map((i) => (
                <button key={i.id} className="nav" aria-current={view === i.id ? 'page' : undefined} onClick={() => setView(i.id)}>
                  {i.label}{i.count && <span className="n">{i.count(data)}</span>}
                </button>
              ))}
            </div>
          ))}
          <div className="spacer" />
          {job?.busy && (
            <button className="agent-status" onClick={() => setView('start')} title={job.log.at(-1) ?? 'startet'}>
              <i className="spinner" aria-hidden />
              <span>
                <span><b>Agent arbeitet</b> · {Math.floor((now - job.started) / 60000)}:{String(Math.floor((now - job.started) / 1000) % 60).padStart(2, '0')}</span>
                <small>{job.log.at(-1) ?? 'startet …'}</small>
              </span>
            </button>
          )}
          <button className="nav" onClick={() => setDark(!dark)}>{dark ? 'Heller Modus' : 'Dunkler Modus'}</button>
        </nav>

        <main className="main">
          <div className="notice-slot" role="status">
            {notice && (
              <div className={`notice ${notice.warn ? 'warn' : ''}`}>
                <span>{notice.text}</span>
                {notice.mvId && <button className="btn" onClick={() => { openMv(notice.mvId!); setNotice(null) }}>Massenverfahren öffnen</button>}
                {notice.retry && <button className="btn" disabled={job?.busy} onClick={poolPruefen}>Pool neu prüfen</button>}
                <button className="btn ghost notice-close" aria-label="Meldung schließen" onClick={() => setNotice(null)}>
                  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
                </button>
              </div>
            )}
          </div>
          {view === 'fragen' ? (
            <Fragen scope={fragenScope} caseName={fragenScope === caseId ? data?.case.name : fragenScope ?? undefined} canScopeCase={!!data}
              onScope={(caseScope) => openFragen(caseScope ? caseId : null)} fragen={fragen} onOpen={openIn} />
          ) : view === 'mv' && mv ? (
            <Massenverfahren key={mv.id} mv={mv} onOpen={(id) => load(id)} job={job} onStart={startJob} />
          ) : view === 'start' || view === 'mv' || !data || !t ? (
            <Start pool={pool} onMassenverfahren={openMv} onOpen={(id) => load(id)} job={job} onStart={startJob} />
          ) : view === 'geschehen' ? <GeschehenTimeline data={data.case} />
            : view === 'verfahren' ? (<><VerfahrenTimeline data={data.case} /><DataTable table={t.verfahren} /></>)
            : view === 'widersprueche' ? <Contradictions data={data.case} />
            : view === 'board' ? <div className="page" style={{ paddingBottom: 16 }}><header><h1>Beweisboard</h1><span className="sub">Karten verschieben, anklicken, Doppelklick öffnet das Beweismittel</span></header><Board key={caseId} data={data.case} board={data.board} suspects={data.suspects ?? {}} onSuspects={(suspects) => setData((d) => d?.case.id === data.case.id ? { ...d, suspects } : d)} /></div>
            : <DataTable key={view} table={t[view]} sub={view === 'akte' && data.case.warnungen.length ? `${data.case.warnungen.length} Validierungshinweise` : undefined} />}
        </main>

        {doc && data && <DocViewer data={data.case} docId={doc.id} anchor={doc.anchor} anchors={doc.anchors} onClose={() => setDoc(null)} />}
      </div>
    </DocCtx.Provider>
  )
}
