import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, type CaseData, type Pool } from './api'
import { Massenverfahren } from './Massenverfahren'
import { Board } from './Board'
import { Contradictions } from './Contradictions'
import { DataTable } from './DataTable'
import { DocViewer } from './DocViewer'
import { DocCtx, type OpenDoc } from './ctx'
import { Start, type JobState } from './Start'
import { GeschehenTimeline, VerfahrenTimeline } from './Timelines'

type View = 'mv' | 'einzelverfahren' | 'start' | 'akte' | 'personen' | 'tatkomplexe' | 'beziehungen' | 'fristen' | 'widersprueche' | 'geschehen' | 'verfahren' | 'board'

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

export default function App() {
  const [pool, setPool] = useState<Pool | null>(null)
  const [mvId, setMvId] = useState<string | null>(null)
  const [caseId, setCaseId] = useState<string | null>(null)
  const [data, setData] = useState<CaseData | null>(null)
  const [view, setView] = useState<View>('start')
  const [doc, setDoc] = useState<{ id: string; anchor?: string; anchors?: string[]; original?: boolean } | null>(null)
  const [dark, setDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches)
  const [job, setJob] = useState<JobState | null>(null)
  const [now, setNow] = useState(Date.now())

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

  const load = useCallback(async (id: string, v: View = 'akte') => {
    setData(await api.get(id)); setCaseId(id); setView(v); setDoc(null); refresh()
  }, [refresh])

  // Agentenlauf: Fortschritt per SSE, unabhängig von der gerade offenen Ansicht
  const startJob = useCallback((jobId: string, id: string, open = true) => {
    setJob({ caseId: id, log: [], busy: true, error: '', started: Date.now() })
    const es = new EventSource(`/api/jobs/${jobId}/events`)
    es.onmessage = (m) => {
      const ev = JSON.parse(m.data)
      if (ev.msg) setJob((j) => j && { ...j, log: [...j.log, ev.msg] })
      if (ev.error) { es.close(); setJob((j) => j && { ...j, busy: false, error: ev.error }); refresh() }
      if (ev.done) { es.close(); setJob((j) => j && { ...j, busy: false }); refresh(); if (open) load(id).catch((err) => setJob((j) => j && { ...j, error: String(err) })) }
    }
    es.onerror = () => { es.close(); setJob((j) => j && { ...j, busy: false, error: j.error || 'Verbindung zum Agenten unterbrochen.' }); refresh() }
  }, [load, refresh])

  const ctx = useMemo(() => ({ open: ((id, anchor, opts) => { if (id) setDoc({ id, anchor, ...opts }) }) as OpenDoc, caseId: caseId ?? '' }), [caseId])
  const t = data?.tables
  const mv = pool?.massenverfahren.find((m) => m.id === mvId)
  const openMv = (id: string) => { setMvId(id); setView('mv'); setDoc(null) }

  return (
    <DocCtx.Provider value={ctx}>
      <div className={`app ${doc && data ? 'with-doc' : ''}`}>
        <nav className="side" aria-label="Navigation">
          <div className="brand">Aktenaufbereiter</div>
          <div className="casename">{data?.case.name ?? 'Keine Akte geöffnet'}</div>
          <div className="nav-group">Aktenpool</div>
          <button className="nav" aria-current={view === 'start' ? 'page' : undefined} onClick={() => { setView('start'); setDoc(null) }}>
            Alle Akten<span className="n">{pool?.einzel.length ?? 0}</span>
          </button>
          {pool?.massenverfahren.map((m) => (
            <button key={m.id} className="nav" title={`Massenverfahren in Sache ${m.sache}`} aria-current={view === 'mv' && mvId === m.id ? 'page' : undefined} onClick={() => openMv(m.id)}>
              <span className="nav-label"><small>Massenverfahren in Sache</small>{m.sache}</span><span className="n">{m.mitglieder.length}</span>
            </button>
          ))}
          {data && NAV.map((g) => (
            <div key={g.group} style={{ display: 'contents' }}>
              <div className="nav-group">{g.group}</div>
              {g.group === 'Verzeichnisse' && data.case.massenverfahren && (
                <button className="nav" aria-current={view === 'einzelverfahren' ? 'page' : undefined} onClick={() => setView('einzelverfahren')}>
                  Einzelverfahren<span className="n">{data.case.massenverfahren.verfahren.length}</span>
                </button>
              )}
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
          {view === 'mv' && mv ? (
            <Massenverfahren key={mv.id} mv={mv} onOpen={(id) => load(id)} job={job} onStart={startJob} />
          ) : view === 'start' || view === 'mv' || !data || !t ? (
            <Start pool={pool} onMassenverfahren={openMv} onOpen={(id) => load(id)} job={job} onStart={startJob} />
          ) : view === 'geschehen' ? <GeschehenTimeline data={data.case} />
            : view === 'verfahren' ? (<><VerfahrenTimeline data={data.case} /><DataTable table={t.verfahren} /></>)
            : view === 'widersprueche' ? <Contradictions data={data.case} />
            : view === 'board' ? <div className="page" style={{ paddingBottom: 16 }}><header><h1>Beweisboard</h1><span className="sub">Karten verschieben, anklicken, Doppelklick öffnet das Beweismittel</span></header><Board key={caseId} data={data.case} board={data.board} suspects={data.suspects ?? {}} onSuspects={(suspects) => setData((d) => d?.case.id === data.case.id ? { ...d, suspects } : d)} /></div>
            : <DataTable key={view} table={t[view]} sub={view === 'akte' && data.case.warnungen.length ? `${data.case.warnungen.length} Validierungshinweise` : undefined} />}
        </main>

        {doc && data && <DocViewer data={data.case} docId={doc.id} anchor={doc.anchor} anchors={doc.anchors} original={doc.original} onClose={() => setDoc(null)} />}
      </div>
    </DocCtx.Provider>
  )
}
