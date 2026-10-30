import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Archive, CalendarClock, Files, Globe, History, ListTree, Milestone, Moon, Network, Pin, Split, Sun, Tags, Users, type LucideIcon } from 'lucide-react'
import { api, type CaseData, type Pool } from './api'
import { Massenverfahren } from './Massenverfahren'
import { Board } from './Board'
import { AktenKopf } from './AktenKopf'
import { Fold, Ladeflaeche } from './components'
import { Contradictions } from './Contradictions'
import { DataTable } from './DataTable'
import { DocViewer } from './DocViewer'
import { Extern } from './Extern'
import { FragenFenster, useFragen } from './Fragen'
import { DocCtx, type OpenDoc } from './ctx'
import { Start, type JobState } from './Start'
import { LoeschMenu, LoeschDialog, aktenZiel, mvZiel, type LoeschZiel, type MenuStand } from './LoeschMenu'
import { GeschehenTimeline, VerfahrenTimeline } from './Timelines'

type View = 'mv' | 'einzelverfahren' | 'start' | 'akte' | 'personen' | 'tatkomplexe' | 'beziehungen' | 'fristen' | 'widersprueche' | 'extern' | 'geschehen' | 'verfahren' | 'board'

const NAV: { group: string; items: { id: View; label: string; icon: LucideIcon; count?: (d: CaseData) => number }[] }[] = [
  { group: 'Verzeichnisse', items: [
    { id: 'akte', label: 'Aktenübersicht', icon: Files, count: (d) => d.case.dokumente.length },
    { id: 'personen', label: 'Personen', icon: Users, count: (d) => d.case.personen.length },
    { id: 'tatkomplexe', label: 'Tatkomplexe', icon: Tags, count: (d) => d.case.tatkomplexe.length },
    { id: 'beziehungen', label: 'Beziehungen', icon: Network, count: (d) => d.tables.beziehungen.rows.length },
    { id: 'fristen', label: 'Fristen & Termine', icon: CalendarClock, count: (d) => d.case.fristen.length },
  ] },
  { group: 'Zeitleisten', items: [
    { id: 'geschehen', label: 'Geschehen', icon: History, count: (d) => d.case.ereignisse.filter((e) => e.kind === 'geschehen').length },
    { id: 'verfahren', label: 'Verfahren', icon: Milestone, count: (d) => d.case.ereignisse.filter((e) => e.kind === 'verfahren').length },
  ] },
  { group: 'Analyse', items: [
    { id: 'board', label: 'Beweisboard', icon: Pin },
    { id: 'widersprueche', label: 'Widersprüche', icon: Split, count: (d) => d.case.widersprueche.length },
    { id: 'extern', label: 'Externe Daten', icon: Globe },
  ] },
]

const AKTEN_ANSICHTEN = new Set<string>(['einzelverfahren', ...NAV.flatMap((g) => g.items.map((i) => i.id))])

/** Die Adresse hält offene Akte und Ansicht fest, damit Neuladen und Zurück-Taste funktionieren. */
type Route = { art: 'start' } | { art: 'mv'; id: string } | { art: 'akte'; id: string; view: View }
function liesRoute(): Route {
  const [art, id, ansicht] = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent)
  if (art === 'mv' && id) return { art, id }
  if (art === 'akte' && id) return { art, id, view: (AKTEN_ANSICHTEN.has(ansicht) ? ansicht : 'akte') as View }
  return { art: 'start' }
}

function themaLesen() {
  try {
    const t = localStorage.getItem('thema')
    if (t === 'dark' || t === 'light') return t === 'dark'
  } catch { /* nur Komfort */ }
  return matchMedia('(prefers-color-scheme: dark)').matches
}

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
  const [start] = useState(liesRoute)
  const [mvId, setMvId] = useState<string | null>(start.art === 'mv' ? start.id : null)
  const [caseId, setCaseId] = useState<string | null>(null)
  const [data, setData] = useState<CaseData | null>(null)
  const [view, setView] = useState<View>(start.art === 'mv' ? 'mv' : 'start')
  const [laedt, setLaedt] = useState(start.art === 'akte')
  const [fragenOffen, setFragenOffen] = useState(false)
  const [fragenVollbild, setFragenVollbild] = useState(false)
  const [bereich, setBereich] = useState<'akte' | 'alle'>('akte')
  const fragen = useFragen()
  const [doc, setDoc] = useState<{ id: string; anchor?: string; anchors?: string[] } | null>(null)
  const [dark, setDark] = useState(themaLesen)
  const [job, setJob] = useState<JobState | null>(null)
  const [now, setNow] = useState(Date.now())
  const [suche, setSuche] = useState('')
  const [menu, setMenu] = useState<MenuStand | null>(null)
  const [loeschDialog, setLoeschDialog] = useState<MenuStand | null>(null)
  const schliesseMenu = useCallback(() => setMenu(null), [])
  const oeffneMenu = (e: React.MouseEvent, ziel: LoeschZiel) => {
    e.preventDefault(); e.stopPropagation()
    const ausloeser = e.currentTarget as HTMLElement
    const rect = ausloeser.getBoundingClientRect()
    setMenu({ ziel, ausloeser, x: e.clientX || e.clientY ? e.clientX : rect.left, y: e.clientX || e.clientY ? e.clientY : rect.bottom })
  }
  const loeschen = async () => {
    if (!loeschDialog) return
    if (job?.busy) throw new Error('Agent arbeitet')
    const { ziel } = loeschDialog
    const gruppe = pool?.massenverfahren.find((m) => m.id === ziel.id)
    const ids = ziel.art === 'akte' ? [ziel.id] : [...(gruppe?.mitglieder.map((a) => a.case_id) ?? []), gruppe?.sammelakte_id]
    if (ziel.art === 'akte') await api.deleteCase(ziel.id)
    else await api.deleteMv(ziel.id)
    setLoeschDialog(null)
    setNotice({ text: `„${ziel.name}“ wurde gelöscht.` })
    if (caseId && ids.includes(caseId)) { setData(null); setCaseId(null); setDoc(null); setView('start') }
    if (ziel.art === 'mv' && mvId === ziel.id) { setMvId(null); setView('start'); setDoc(null) }
    refresh()
  }

  useEffect(() => {
    if (!job?.busy) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [job?.busy])

  useEffect(() => {
    const thema = dark ? 'dark' : 'light'
    document.documentElement.dataset.theme = thema
    try { localStorage.setItem('thema', thema) } catch { /* nur Komfort */ }
  }, [dark])
  const refresh = useCallback(() => Promise.all([
    api.cases().catch(() => []),
    api.pool().then(setPool).catch(() => setPool({ einzel: [], massenverfahren: [] })),
  ]), [])
  useEffect(() => { refresh() }, [refresh])
  useEffect(() => { poolRef.current = pool }, [pool])

  const load = useCallback(async (id: string, v: View = 'akte', preserveView = false) => {
    if (!preserveView) setLaedt(true)
    try {
      const next = await api.get(id)
      setData(next); setCaseId(id)
      if (!preserveView) { setView(v); setDoc(null) }
      refresh()
    } finally { if (!preserveView) setLaedt(false) }
  }, [refresh])
  const oeffne = useCallback((id: string, v?: View) => {
    load(id, v).catch((error) => setNotice({ text: `Akte konnte nicht geöffnet werden: ${error}`, warn: true }))
  }, [load])

  // Adresse und Zustand abgleichen: beim Start, bei Zurück/Vor und nach jedem Wechsel der Ansicht
  const routeAnwenden = useCallback((r: Route, offeneAkte: string | null) => {
    if (r.art === 'akte') {
      if (r.id !== offeneAkte) oeffne(r.id, r.view)
      else { setView(r.view); setDoc(null) }
    } else if (r.art === 'mv') { setMvId(r.id); setView('mv'); setDoc(null) }
    else { setView('start'); setDoc(null) }
  }, [oeffne])
  useEffect(() => { if (start.art === 'akte') routeAnwenden(start, null) }, [start, routeAnwenden])
  useEffect(() => {
    if (laedt) return
    const ziel = view === 'mv' && mvId ? `#/mv/${encodeURIComponent(mvId)}` : view !== 'start' && caseId ? `#/akte/${encodeURIComponent(caseId)}/${view}` : '#/'
    if ((location.hash || '#/') === ziel) return
    location.hash = ziel
  }, [laedt, view, mvId, caseId])
  useEffect(() => {
    const geaendert = () => {
      const r = liesRoute()
      if (r.art === 'akte' ? r.id !== caseId || r.view !== view : r.art === 'mv' ? r.id !== mvId || view !== 'mv' : view !== 'start') routeAnwenden(r, caseId)
    }
    addEventListener('hashchange', geaendert)
    return () => removeEventListener('hashchange', geaendert)
  }, [caseId, view, mvId, routeAnwenden])

  const openIn = async (id: string, docId: string, anchors: string[]) => {
    try {
      if (!caseId) setBereich('alle') // Pool-Frage: Antwort bleibt sichtbar, wenn der Beleg eine Akte lädt
      if (id !== caseId) await load(id, undefined, true)
      setDoc({ id: docId, anchors })
      if (matchMedia('(max-width: 900px)').matches || (!fragenVollbild && matchMedia('(max-width: 1100px)').matches)) setFragenOffen(false)
    } catch (error) { setNotice({ text: `Akte konnte nicht geöffnet werden: ${error}`, warn: true }) }
  }

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

  const ctx = useMemo(() => ({ open: ((id, anchor, opts) => { if (id) setDoc({ id, anchor, ...opts }) }) as OpenDoc, caseId: caseId ?? '', dokumente: data?.case.dokumente ?? [] }), [caseId, data])
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
  const aktenwahl = <>
    <input type="search" className="side-search" aria-label="Akten filtern" placeholder="Akten filtern" value={suche} onChange={(e) => setSuche(e.target.value)} />
    <Fold key={data ? 'mit-akte' : 'ohne-akte'} id={data ? 'side:aktenpool:akte' : 'side:aktenpool'} defaultOpen={!data} forceOpen={filtert} className="side-fold" title={<>Aktenpool<span className="n">{einzel.length}</span></>}>
      {einzel.map((c) => (
        <button key={c.id} className="nav" onContextMenu={(e) => oeffneMenu(e, aktenZiel(c.id, c.name))} title={c.name} aria-current={view !== 'start' && view !== 'mv' && caseId === c.id ? 'true' : undefined} onClick={() => oeffne(c.id)}>
          <span className="nav-label">{c.name}</span>
        </button>
      ))}
    </Fold>
    {gruppen.length > 0 && (
      <Fold key={data ? 'mv-mit-akte' : 'mv-ohne-akte'} id={data ? 'side:massenverfahren:akte' : 'side:massenverfahren'} defaultOpen={!data} forceOpen={filtert} className="side-fold" title={<>Massenverfahren<span className="n">{gruppen.length}</span></>}>
        {gruppen.map((m) => (
          <button key={m.id} className="nav" onContextMenu={(e) => oeffneMenu(e, mvZiel(m))} title={`Massenverfahren in Sache ${m.sache}`} aria-current={view === 'mv' && mvId === m.id ? 'page' : undefined} onClick={() => openMv(m.id)}>
            <span className="nav-label">{m.sache}</span><span className="n">{m.mitglieder.length}</span>
          </button>
        ))}
      </Fold>
    )}
    {filtert && !einzel.length && !gruppen.length && <p className="side-empty">Keine Treffer</p>}
  </>
  const poolPruefen = async () => {
    try {
      const { job } = await api.refreshPool()
      startJob(job, '', false)
    } catch (err) { setNotice({ text: `Pool-Prüfung nicht gestartet: ${err}`, warn: true, retry: true }) }
  }

  return (
    <DocCtx.Provider value={ctx}>
      {menu && <LoeschMenu stand={menu} deaktiviert={!!job?.busy} onClose={schliesseMenu}
        onWaehlen={() => { setMenu(null); setLoeschDialog(menu) }} />}
      {loeschDialog && <LoeschDialog ziel={loeschDialog.ziel} ausloeser={loeschDialog.ausloeser}
        onClose={() => setLoeschDialog(null)} onLoeschen={loeschen} />}
      <div className={`app ${doc && data ? 'with-doc' : ''}`}>
        <nav className={`side ${data ? 'mit-akte' : ''}`} aria-label="Navigation">
          <div className="brand">Aktenaufbereiter</div>
          <div className="casename">{data?.case.name ?? 'Keine Akte geöffnet'}</div>
          <button className="nav" aria-current={view === 'start' ? 'page' : undefined} onClick={() => { setView('start'); setDoc(null) }}><Archive size={16} aria-hidden />Übersicht</button>
          {!data && aktenwahl}
          {data && NAV.map((g) => (
            <div key={g.group} style={{ display: 'contents' }}>
              <div className="nav-group">{g.group}</div>
              {g.group === 'Verzeichnisse' && data.case.massenverfahren && (
                <button className="nav" aria-current={view === 'einzelverfahren' ? 'page' : undefined} onClick={() => setView('einzelverfahren')}>
                  <ListTree size={16} aria-hidden />Einzelverfahren<span className="n">{data.case.massenverfahren.verfahren.length}</span>
                </button>
              )}
              {g.items.map((i) => (
                <button key={i.id} className="nav" aria-current={view === i.id ? 'page' : undefined} onClick={() => setView(i.id)}>
                  <i.icon size={16} aria-hidden />{i.label}{i.count && <span className="n">{i.count(data)}</span>}
                </button>
              ))}
            </div>
          ))}
          {data && aktenwahl}
          <div className="spacer" />
          <div className="side-fuss">
          {job?.busy && (
            <button className="agent-status" onClick={() => setView('start')} title={job.log.at(-1) ?? 'startet'}>
              <i className="spinner" aria-hidden />
              <span>
                <span><b>Agent arbeitet</b> · {Math.floor((now - job.started) / 60000)}:{String(Math.floor((now - job.started) / 1000) % 60).padStart(2, '0')}</span>
                <small>{job.log.at(-1) ?? 'startet …'}</small>
              </span>
            </button>
          )}
          <button className="nav" onClick={() => setDark(!dark)}>{dark ? <Sun size={16} aria-hidden /> : <Moon size={16} aria-hidden />}{dark ? 'Heller Modus' : 'Dunkler Modus'}</button>
          </div>
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
          {laedt ? <Ladeflaeche /> : view === 'mv' && mv ? (
            <Massenverfahren key={mv.id} mv={mv} onOpen={(id) => oeffne(id)} job={job} onStart={startJob} />
          ) : view === 'start' || view === 'mv' || !data || !t ? (
            <Start onMenu={oeffneMenu} pool={pool} onMassenverfahren={openMv} onOpen={(id) => oeffne(id)} job={job} onStart={startJob} />
          ) : view === 'geschehen' ? <GeschehenTimeline data={data.case} />
            : view === 'verfahren' ? (<><VerfahrenTimeline data={data.case} /><DataTable table={t.verfahren} /></>)
            : view === 'widersprueche' ? <Contradictions data={data.case} />
            : view === 'extern' ? <Extern key={caseId} caseId={data.case.id} />
            : view === 'board' ? <div className="page" style={{ paddingBottom: 16 }}><header><h1>Beweisboard</h1><span className="sub">Karten verschieben, anklicken, Doppelklick öffnet das Beweismittel</span></header><Board key={caseId} data={data.case} board={data.board} suspects={data.suspects ?? {}} onSuspects={(suspects) => setData((d) => d?.case.id === data.case.id ? { ...d, suspects } : d)} /></div>
            : t[view] ? <DataTable key={view} table={t[view]} sub={view === 'akte' && data.case.warnungen.length ? `${data.case.warnungen.length} Validierungshinweise` : undefined} kopf={view === 'akte' ? <AktenKopf data={data.case} onAnsicht={setView} /> : undefined} />
            : <div className="page empty">Diese Ansicht gibt es für diese Akte nicht.</div>}
        </main>

        {doc && data && <DocViewer data={data.case} docId={doc.id} anchor={doc.anchor} anchors={doc.anchors} onClose={() => setDoc(null)} />}
        <FragenFenster scope={bereich === 'akte' && caseId ? caseId : null} caseName={data?.case.name} hatAkte={!!caseId}
          onBereich={setBereich} fragen={fragen} onOpen={openIn} dokumentOffen={!!doc && !!data}
          offen={fragenOffen} onOffen={setFragenOffen} vollbild={fragenVollbild} onVollbild={setFragenVollbild} />
      </div>
    </DocCtx.Provider>
  )
}
