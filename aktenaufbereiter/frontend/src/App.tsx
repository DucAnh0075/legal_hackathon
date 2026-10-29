import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, type CaseData, type CaseInfo } from './api'
import { Board } from './Board'
import { Contradictions } from './Contradictions'
import { DataTable } from './DataTable'
import { DocViewer } from './DocViewer'
import { DocCtx } from './ctx'
import { Start, type JobState } from './Start'
import { GeschehenTimeline, VerfahrenTimeline } from './Timelines'

type View = 'start' | 'akte' | 'personen' | 'tatkomplexe' | 'beziehungen' | 'fristen' | 'widersprueche' | 'offene_fragen' | 'geschehen' | 'verfahren' | 'board'

const NAV: { group: string; items: { id: View; label: string; count?: (d: CaseData) => number }[] }[] = [
  { group: 'Verzeichnisse', items: [
    { id: 'akte', label: 'Aktenübersicht', count: (d) => d.case.dokumente.length },
    { id: 'personen', label: 'Personen', count: (d) => d.case.personen.length },
    { id: 'tatkomplexe', label: 'Tatkomplexe', count: (d) => d.case.tatkomplexe.length },
    { id: 'beziehungen', label: 'Beziehungen', count: (d) => d.case.beziehungen.length },
    { id: 'fristen', label: 'Fristen & Termine', count: (d) => d.case.fristen.length },
  ] },
  { group: 'Zeitleisten', items: [
    { id: 'geschehen', label: 'Geschehen', count: (d) => d.case.ereignisse.filter((e) => e.kind === 'geschehen').length },
    { id: 'verfahren', label: 'Verfahren', count: (d) => d.case.ereignisse.filter((e) => e.kind === 'verfahren').length },
  ] },
  { group: 'Analyse', items: [
    { id: 'board', label: 'Beweisboard' },
    { id: 'widersprueche', label: 'Widersprüche', count: (d) => d.case.widersprueche.length },
    { id: 'offene_fragen', label: 'Offene Fragen', count: (d) => d.case.offene_fragen?.length ?? 0 },
  ] },
]

export default function App() {
  const [cases, setCases] = useState<CaseInfo[]>([])
  const [caseId, setCaseId] = useState<string | null>(null)
  const [data, setData] = useState<CaseData | null>(null)
  const [view, setView] = useState<View>('start')
  const [doc, setDoc] = useState<{ id: string; anchor?: string } | null>(null)
  const [dark, setDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches)
  const [job, setJob] = useState<JobState | null>(null)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (!job?.busy) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [job?.busy])

  useEffect(() => { document.documentElement.dataset.theme = dark ? 'dark' : 'light' }, [dark])
  const refresh = useCallback(() => api.cases().then(setCases).catch(() => setCases([])), [])
  useEffect(() => { refresh() }, [refresh])

  const load = useCallback(async (id: string, v: View = 'akte') => {
    setData(await api.get(id)); setCaseId(id); setView(v); setDoc(null); refresh()
  }, [refresh])

  // Agentenlauf: Fortschritt per SSE, unabhängig von der gerade offenen Ansicht
  const startJob = useCallback((jobId: string, id: string) => {
    setJob({ caseId: id, log: [], busy: true, error: '', started: Date.now() })
    const es = new EventSource(`/api/jobs/${jobId}/events`)
    es.onmessage = (m) => {
      const ev = JSON.parse(m.data)
      if (ev.msg) setJob((j) => j && { ...j, log: [...j.log, ev.msg] })
      if (ev.error) { es.close(); setJob((j) => j && { ...j, busy: false, error: ev.error }) }
      if (ev.done) { es.close(); setJob((j) => j && { ...j, busy: false }); load(id) }
    }
    es.onerror = () => { es.close(); setJob((j) => j && { ...j, busy: false, error: j.error || 'Verbindung zum Agenten unterbrochen.' }) }
  }, [load])

  const ctx = useMemo(() => ({ open: (id: string, anchor?: string) => id && setDoc({ id, anchor }), caseId: caseId ?? '' }), [caseId])
  const t = data?.tables

  return (
    <DocCtx.Provider value={ctx}>
      <div className={`app ${doc && data ? 'with-doc' : ''}`}>
        <nav className="side" aria-label="Navigation">
          <div className="brand">Aktenaufbereiter</div>
          <div className="casename">{data?.case.name ?? 'Keine Akte geöffnet'}</div>
          <button className="nav" aria-current={view === 'start' ? 'page' : undefined} onClick={() => setView('start')}>Start / Neue Akte</button>
          {data && NAV.map((g) => (
            <div key={g.group} style={{ display: 'contents' }}>
              <div className="nav-group">{g.group}</div>
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
          {view === 'start' || !data || !t ? (
            <Start cases={cases} onOpen={(id) => load(id)} job={job} onStart={startJob} />
          ) : view === 'geschehen' ? <GeschehenTimeline data={data.case} />
            : view === 'verfahren' ? (<><VerfahrenTimeline data={data.case} /><DataTable table={t.verfahren} /></>)
            : view === 'widersprueche' ? <Contradictions data={data.case} />
            : view === 'board' ? <div className="page" style={{ paddingBottom: 16 }}><header><h1>Beweisboard</h1><span className="sub">Karten verschieben, anklicken, Doppelklick öffnet das Beweismittel</span></header><Board data={data.case} /></div>
            : <DataTable key={view} table={t[view]} sub={view === 'akte' && data.case.warnungen.length ? `${data.case.warnungen.length} Validierungshinweise` : undefined} />}
        </main>

        {doc && data && <DocViewer data={data.case} docId={doc.id} anchor={doc.anchor} onClose={() => setDoc(null)} />}
      </div>
    </DocCtx.Provider>
  )
}
