import { useCallback, useEffect, useMemo, useState } from 'react'
import { BaseEdge, MarkerType, EdgeLabelRenderer, getStraightPath, type EdgeProps, Background, Controls, Handle, Position, ReactFlow, type Edge, type Node, type NodeProps, type NodeChange, applyNodeChanges } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { api, type Case, type BoardStruktur, type Fundstelle } from './api'
import { useDocs } from './ctx'

type Point = { x: number; y: number }
type Positions = Record<string, Point>
type Thread = Edge<{ labelPos?: Point; title?: string; dim?: boolean; contra?: boolean; thin?: boolean; onSelect?: () => void }>

function ThreadEdge(props: EdgeProps<Thread>) {
  const [path, x, y] = getStraightPath(props)
  const { data, label } = props
  const text = String(label ?? '')
  const pos = data?.labelPos ?? { x, y }
  return <>
    <BaseEdge id={props.id} path={path} style={props.style} markerEnd={props.markerEnd} markerStart={props.markerStart} />
    {text && !data?.thin && <EdgeLabelRenderer>
      <div className={`thread-label nodrag nopan${data?.dim ? ' dim' : ''}${data?.contra ? ' contra' : ''}`}
        style={{ transform: `translate(-50%,-50%) translate(${pos.x}px,${pos.y}px)` }} title={data?.title ?? text} role="button" tabIndex={0}
        onClick={(e) => { e.stopPropagation(); data?.onSelect?.() }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); data?.onSelect?.() } }}>
        {text.length > 42 ? `${text.slice(0, 41)}…` : text}
      </div>
    </EdgeLabelRenderer>}
  </>
}
const edgeTypes = { thread: ThreadEdge }

type Rect = Point & { width: number; height: number }
const overlap = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))

// Kandidaten: von der Fadenmitte nach außen, dann seitlich versetzt
const T_STEPS = [0.5, 0.45, 0.55, 0.4, 0.6, 0.35, 0.65, 0.3, 0.7, 0.25, 0.75, 0.2, 0.8, 0.15, 0.85]
const OFFSETS = [0, 26, -26, 52, -52, 78, -78, 104, -104, 130, -130]

export function placeLabels(nodes: Node<NData>[], edges: Edge[]): Positions {
  const cards = new Map(nodes.map((n) => {
    const [w, h] = n.data.kind === 'person' ? [168, 150] : n.data.kind === 'doc' ? [142, 120] : [168, 80]
    return [n.id, { ...n.position, width: n.measured?.width ?? w, height: n.measured?.height ?? h }]
  }))
  const occupied: Rect[] = [...cards.values()].map((r) => ({ x: r.x - 10, y: r.y - 10, width: r.width + 20, height: r.height + 20 }))
  const lines = edges.flatMap((e) => {
    const a = cards.get(e.source), b = cards.get(e.target)
    if (!e.label || e.className?.split(' ').includes('thin') || !a || !b) return []
    const x = a.x + a.width / 2, y = a.y + a.height / 2
    const dx = b.x + b.width / 2 - x, dy = b.y + b.height / 2 - y
    return [{ e, x, y, dx, dy, length: Math.hypot(dx, dy) }]
  }).sort((a, b) => b.length - a.length)
  const result: Positions = {}
  for (const { e, x, y, dx, dy, length } of lines) {
    const width = Math.min(42, String(e.label).length) * 6.6 + 16
    let best: Rect | undefined, area = Infinity
    candidates: for (const t of T_STEPS) {
      for (const offset of OFFSETS) {
        const r = { x: x + dx * t - dy / (length || 1) * offset - width / 2, y: y + dy * t + dx / (length || 1) * offset - 11, width, height: 22 }
        const score = occupied.reduce((sum, other) => sum + overlap(r, other), 0)
        if (score < area) { best = r; area = score }
        if (!score) break candidates
      }
    }
    if (best) { result[e.id] = { x: best.x + width / 2, y: best.y + 11 }; occupied.push(best) }
  }
  return result
}

function readLayout(layout: Record<string, unknown>): Positions {
  if (layout._v !== 5) return {}
  return Object.fromEntries(Object.entries(layout).filter((entry): entry is [string, Point] => {
    const [id, p] = entry
    return id !== '_v' && !!p && typeof p === 'object' && 'x' in p && 'y' in p && typeof p.x === 'number' && typeof p.y === 'number' && Number.isFinite(p.x) && Number.isFinite(p.y)
  }))
}

type NData = { kind: 'person' | 'entity' | 'doc' | 'evidence' | 'heading'; side?: 'side-a' | 'side-b'; group?: 'haupt' | 'vertreter' | 'zeugen' | 'weitere' | 'beweismittel'; tag?: string; title: string; sub?: string; initials?: string; dim: boolean; sel: boolean; suspect: boolean; basis?: string }

const hidden = { opacity: 0, top: '50%', left: '50%', width: 1, height: 1, minWidth: 0, minHeight: 0, border: 0 }
function CardNode({ data }: NodeProps<Node<NData>>) {
  if (data.kind === 'heading') return <div className={`board-heading ${data.side}`}>{data.title}</div>
  return (
    <div className={`card ${data.kind} ${data.side ?? ''} ${data.group ?? ''} ${data.dim ? 'dim' : ''} ${data.sel ? 'sel' : ''} ${data.suspect ? 'suspect' : ''}`} title={data.basis}>
      <i className="pin" />
      <Handle type="target" position={Position.Top} style={hidden} isConnectable={false} />
      <Handle type="source" position={Position.Top} style={hidden} isConnectable={false} />
      {data.kind === 'person' && <div className="photo" aria-hidden>{data.initials}</div>}
      <div className="kind">{data.kind === 'person' ? 'Person' : data.kind === 'doc' || data.kind === 'evidence' ? 'Beweismittel' : 'Beteiligte'}{data.suspect && <span className="suspect-tag">Hauptverdächtig</span>}</div>
      {data.tag && <span className="party-tag">{data.tag}</span>}
      <div className="nm">{data.title}</div>
      {data.sub && <div className="sub">{data.sub}</div>}
    </div>
  )
}
const nodeTypes = { card: CardNode }

type Meta = Pick<NData, 'side' | 'group' | 'tag'> & { id: string; kind: NData['kind']; title: string; sub?: string; docs: string[]; fund: Fundstelle[]; text?: string; rest?: string }

const EMPTY_BOARD: BoardStruktur = { verfahrensart: 'straf', aktiv: { bezeichnung: '', haupt: [], vertreter: [], zeugen: [] }, passiv: { bezeichnung: '', haupt: [], vertreter: [], zeugen: [] }, weitere: [], beweismittel: [] }
const beweisId = (b: BoardStruktur['beweismittel'][number], i: number) => b.doc_id ?? `board:beweis:${i}`

const beweisPersonen = (board: BoardStruktur) => new Set([board.aktiv, board.passiv].flatMap((s) => [...s.haupt, ...s.zeugen.map((r) => r.id)]))

export function grundlayout(board: BoardStruktur): Positions {
  const pos: Positions = {}
  const richtungen = new Map<string, number>()
  const personen = beweisPersonen(board)
  const P = Math.max(3 * 200 + 600, (board.aktiv.vertreter.length + board.passiv.vertreter.length) * 210 + 600)
  ;[board.aktiv, board.passiv].forEach((seite, s) => {
    const x = s * P, dir = s ? 1 : -1
    pos[`board:kopf:${s}`] = { x, y: -150 }
    const place = (id: string, dx: number, y: number) => {
      if (!pos[id]) { pos[id] = { x: x + dx, y }; richtungen.set(id, dir) }
    }
    seite.haupt.forEach((id, i) => place(id, dir * i * 210, 0))
    seite.vertreter.forEach((r, i) => place(r.id, -dir * (230 + i * 210), 260))
    seite.zeugen.forEach((r, i) => place(r.id, dir * (i % 3) * 400, 520 + Math.floor(i / 3) * 300))
  })
  // Gemeinsame Beweismittel zählen pro Person nur einmal.
  const owners = new Map<string, Set<string>>()
  board.beweismittel.forEach((b, i) => {
    if (!personen.has(b.person)) return
    const id = beweisId(b, i)
    if (!owners.has(id)) owners.set(id, new Set())
    owners.get(id)!.add(b.person)
  })
  const counts = new Map<string, number>()
  const sharedColumns = Math.min(3, [...owners].filter(([id, people]) => people.size > 1 && !pos[id]).length)
  let shared = 0
  owners.forEach((people, id) => {
    if (pos[id]) return
    if (people.size > 1) {
      pos[id] = { x: P / 2 + (shared % 3 - (sharedColumns - 1) / 2) * 200, y: 520 + Math.floor(shared / 3) * 160 }
      shared++
      return
    }
    const person = [...people][0], p = pos[person], dir = richtungen.get(person)!
    const n = counts.get(person) ?? 0
    pos[id] = { x: p.x + dir * 200 * (1 + Math.floor(n / 3)), y: p.y + n % 3 * 130 }
    counts.set(person, n + 1)
  })
  const bottom = Math.max(0, ...Object.values(pos).map((p) => p.y + 180)) + 220
  const left = Math.min(0, ...Object.values(pos).map((p) => p.x))
  board.weitere.filter((r) => !pos[r.id]).forEach((r, i) => {
    pos[r.id] = { x: left + i % 8 * 210, y: bottom + Math.floor(i / 8) * 260 }
  })
  return pos
}

export function Board({ data, board = EMPTY_BOARD, suspects, onSuspects }: { data: Case; board?: BoardStruktur; suspects: Record<string, boolean>; onSuspects: (next: Record<string, boolean>) => void }) {
  const { caseId, open } = useDocs()
  const [show, setShow] = useState({ vertreter: true, zeugen: true, beweismittel: true, weitere: true, beziehungen: true, widersprueche: false })
  const [sel, setSel] = useState<string | null>(null)
  const [nodes, setNodes] = useState<Node<NData>[]>([])
  const [layout, setLayout] = useState<Positions>({})
  const [saved, setSaved] = useState<Positions | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const isSuspect = (id: string) => board.verfahrensart === 'straf' && (suspects[id] ?? board.passiv.haupt.includes(id))

  const personen = useMemo(() => beweisPersonen(board), [board])
  const metas = useMemo(() => {
    const m = new Map<string, Meta>()
    const add = (id: string, rolle: string, group: Meta['group'], side?: Meta['side'], tag?: string) => {
      if (m.has(id)) return
      const p = data.personen.find((p) => p.id === id), e = data.entitaeten.find((e) => e.id === id)
      if (!p && !e) return
      const fund = p?.fundstellen ?? e!.fundstellen
      m.set(id, { id, kind: p ? 'person' : 'entity', title: p?.name ?? e!.label, sub: rolle, group, side, tag,
        docs: fund.map((f) => f.doc_id), fund: [...fund], text: p?.adresse ?? e?.details ?? undefined,
        rest: p?.aliases.length ? `auch: ${p.aliases.join(', ')}` : undefined })
    }
    ;[board.aktiv, board.passiv].forEach((seite, i) => {
      const side = i ? 'side-b' : 'side-a'
      const tag = board.verfahrensart === 'zivil' ? (i ? 'Beklagte' : 'Klägerin') : (i ? 'Angeklagte(r)' : 'Anklage')
      seite.haupt.forEach((id) => add(id, seite.bezeichnung, 'haupt', side, tag))
      seite.vertreter.forEach((r) => add(r.id, r.rolle, 'vertreter', side))
      seite.zeugen.forEach((r) => add(r.id, r.rolle, 'zeugen', side))
    })
    board.weitere.forEach((r) => add(r.id, r.rolle, 'weitere'))
    board.beweismittel.forEach((b, i) => {
      if (!personen.has(b.person) || !m.has(b.person)) return
      const id = beweisId(b, i), old = m.get(id)
      if (old) { old.fund.push(...b.fundstellen); return }
      const d = data.dokumente.find((d) => d.id === b.doc_id)
      m.set(id, { id, kind: b.doc_id ? 'doc' : 'evidence', title: d?.title || b.bezeichnung, sub: d?.doc_type,
        group: 'beweismittel', docs: b.doc_id ? [b.doc_id] : [], fund: [...b.fundstellen], text: d?.essentialia })
    })
    return m
  }, [data, board, personen])

  const visible = useMemo(() => {
    const ids = new Set([...metas.values()].filter((m) => m.group !== 'beweismittel' && (m.group === 'haupt' || !m.group || show[m.group])).map((m) => m.id))
    if (show.beweismittel) board.beweismittel.forEach((b, i) => {
      if (personen.has(b.person) && ids.has(b.person) && metas.has(beweisId(b, i))) ids.add(beweisId(b, i))
    })
    return ids
  }, [metas, show, board, personen])
  const edges = useMemo(() => {
    const out: Thread[] = []
    const add = (id: string, source: string, target: string, label?: string, className = '', title?: string) => {
      if (source === target || !visible.has(source) || !visible.has(target)) return
      const color = className.includes('side-a') ? 'var(--side-a)' : className.includes('side-b') ? 'var(--side-b)' : className === 'evidence' ? 'var(--muted)' : 'var(--thread)'
      out.push({ id, source, target, label, className, type: 'thread', data: { title }, markerEnd: { type: MarkerType.ArrowClosed, color, ...(className === 'evidence' ? { width: 12, height: 12 } : {}) } })
    }
    board.aktiv.haupt.forEach((a) => board.passiv.haupt.forEach((b) => add(`main:${a}:${b}`, a, b, board.verfahrensart === 'zivil' ? 'Klage gegen' : 'Anklage gegen', 'main side-a')))
    ;[board.aktiv, board.passiv].forEach((seite, i) => {
      const main = seite.haupt[0]
      if (!main) return
      seite.vertreter.forEach((r) => add(`vertreter:${i}:${r.id}`, main, r.id, 'vertreten durch', i ? 'side-b' : 'side-a'))
      seite.zeugen.forEach((r) => add(`zeuge:${i}:${r.id}`, main, r.id, /zeugin/i.test(r.rolle) ? 'Zeugin' : 'Zeuge', i ? 'side-b' : 'side-a', r.rolle))
    })
    board.beweismittel.forEach((b, i) => {
      if (personen.has(b.person)) add(`beweis:${i}`, b.person, beweisId(b, i), undefined, 'evidence')
    })
    if (show.beziehungen) data.beziehungen.forEach((r) => add(`relation:${r.id}`, r.von, r.zu, r.beziehung, 'relation'))
    if (show.widersprueche) data.widersprueche.forEach((w) => {
      const docs = [...new Set(w.varianten.flatMap((v) => v.fundstellen.map((f) => f.doc_id)))].filter((id) => visible.has(id) && metas.get(id)?.kind === 'doc')
      for (let i = 0; i < docs.length - 1; i++) add(`${w.id}-${i}`, docs[i], docs[i + 1], `Widerspruch: ${w.thema}`, 'contra')
    })
    return out
  }, [data, board, visible, show, metas, personen])

  useEffect(() => { let active = true; api.get(caseId).then((d) => { if (active) setSaved(readLayout(d.layout)) }).catch(() => { if (active) setSaved({}) }); return () => { active = false } }, [caseId])
  useEffect(() => { if (saved) setLayout({ ...grundlayout(board), ...saved }) }, [board, saved])

  // Nachbarn der Auswahl
  const near = useMemo(() => {
    if (!sel) return null
    const s = new Set([sel])
    edges.forEach((e) => { if (e.source === sel) s.add(e.target); if (e.target === sel) s.add(e.source) })
    return s
  }, [sel, edges])

  useEffect(() => {
    setNodes((previous) => [...visible].map((id): Node<NData> => {
      const m = metas.get(id)!
      return { id, measured: previous.find((n) => n.id === id)?.measured, type: 'card', position: layout[id] ?? { x: 0, y: 0 }, draggable: true,
        data: { side: m.side, group: m.group, tag: m.tag, suspect: m.kind === 'person' && isSuspect(id), basis: m.kind === 'person' && isSuspect(id) ? (suspects[id] === true ? 'manuell markiert' : `Rolle laut Akte: ${m.sub}`) : undefined, kind: m.kind, title: m.title, sub: m.sub, initials: m.kind === 'person' ? m.title.split(/\s+/).map((w) => w[0]).slice(0, 2).join('') : undefined, dim: !!near && !near.has(id), sel: sel === id } }
    }).concat([board.aktiv, board.passiv].map((_, i): Node<NData> => ({
      id: `board:kopf:${i}`, type: 'card', position: layout[`board:kopf:${i}`] ?? { x: i * Math.max(3 * 200 + 600, (board.aktiv.vertreter.length + board.passiv.vertreter.length) * 210 + 600), y: -150 },
      selectable: false, draggable: false, connectable: false, focusable: false,
      data: { kind: 'heading', side: i ? 'side-b' : 'side-a', title: board.verfahrensart === 'zivil' ? (i ? 'Beklagtenseite' : 'Klägerseite') : (i ? 'Angeklagte(r) · Verteidigung' : 'Anklage'), dim: false, sel: false, suspect: false },
    }))))
  }, [visible, metas, layout, near, sel, suspects, board])

  const onNodesChange = useCallback((c: NodeChange<Node<NData>>[]) => setNodes((n) => applyNodeChanges(c, n)), [])
  const labelPositions = useMemo(() => placeLabels(nodes, edges), [nodes, edges])
  const styled = useMemo(() => edges.map((e): Thread => {
    const dim = !!near && !(near.has(e.source) && near.has(e.target) && (e.source === sel || e.target === sel))
    return { ...e, className: `${e.className ?? ''}${dim ? ' dim' : ''}`, data: {
      ...e.data, labelPos: labelPositions[e.id], dim, contra: e.className === 'contra', thin: e.className === 'thin',
      onSelect: () => setSel(e.target === sel ? e.source : e.target),
    } }
  }), [edges, near, sel, labelPositions])

  const selMeta = sel ? metas.get(sel) : null
  const links = sel ? edges.filter((e) => (e.source === sel || e.target === sel) && e.className !== 'thin') : []

  return (
    <div className="boardwrap cork">
      <ReactFlow key={`${[...visible].join()}|${Object.keys(layout).length ? 'ready' : 'wait'}`} nodes={nodes} edges={styled} nodeTypes={nodeTypes} onNodesChange={onNodesChange} fitView fitViewOptions={{ padding: { top: '120px', left: '40px', right: '40px', bottom: '40px' }, maxZoom: 1 }} minZoom={0.15} maxZoom={1.8}
        onNodeClick={(_, n) => { if (n.data.kind !== 'heading') setSel(n.id === sel ? null : n.id) }} onPaneClick={() => setSel(null)}
        onNodeDoubleClick={(_, n) => metas.get(n.id)?.kind === 'doc' && open(n.id)}
        onNodeDragStop={(_, n) => { const next = { ...layout, ...Object.fromEntries(nodes.map((x) => [x.id, x.position])), [n.id]: n.position }; setLayout(next); setSaved(next); api.saveLayout(caseId, { ...next, _v: 5 }) }}
        edgeTypes={edgeTypes} proOptions={{ hideAttribution: true }}>
        <Background gap={40} size={0} />
        <Controls showInteractive={false} />
      </ReactFlow>

      <div className="boardbar">
        <button className="btn" onClick={() => { setSaved({}); api.saveLayout(caseId, { _v: 5 }) }}>Neu anordnen</button>
        {(Object.entries({ vertreter: 'Vertreter', zeugen: 'Zeugen', beweismittel: 'Beweismittel', weitere: 'Weitere Beteiligte', beziehungen: 'Beziehungen', widersprueche: 'Widersprüche' }) as [keyof typeof show, string][]).map(([k, label]) => (
          <label key={k} style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
            <input type="checkbox" checked={show[k]} onChange={(e) => setShow({ ...show, [k]: e.target.checked })} />{label}
          </label>
        ))}
      </div>

      {selMeta && (
        <aside className="detail">
          <h3>{selMeta.title}</h3>
          {selMeta.sub && <p>{selMeta.sub}</p>}
          {selMeta.text && <p style={{ color: 'var(--ink)' }}>{selMeta.text}</p>}
          {selMeta.rest && <p>{selMeta.rest}</p>}
          {board.verfahrensart === 'straf' && selMeta.kind === 'person' && <button className="btn" disabled={saving} onClick={async () => {
            const next = { ...suspects, [selMeta.id]: !isSuspect(selMeta.id) }
            setSaving(true); setError('')
            try { await api.saveSuspects(caseId, next); onSuspects(next) }
            catch { setError('Markierung konnte nicht gespeichert werden. Bitte erneut versuchen.') }
            finally { setSaving(false) }
          }}>{isSuspect(selMeta.id) ? 'Markierung entfernen' : 'Als hauptverdächtig markieren'}</button>}
          {error && <p className="err" role="alert">{error}</p>}
          {links.length > 0 && (
            <>
              <b style={{ fontSize: 12.5 }}>Verbindungen</b>
              <div style={{ display: 'grid', gap: 4 }}>
                {links.map((e) => {
                  const other = e.source === sel ? e.target : e.source
                  return <button key={e.id} className="btn" style={{ textAlign: 'left' }} onClick={() => setSel(other)}>{String(e.label ?? 'verbunden')} → {metas.get(other)?.title}</button>
                })}
              </div>
            </>
          )}
          <b style={{ fontSize: 12.5 }}>Fundstellen</b>
          <div className="row">
            {selMeta.kind === 'doc' ? <button className="btn primary" onClick={() => open(selMeta.id)}>Datei öffnen</button> : null}
            {[...new Set(selMeta.fund.map((f) => f.doc_id))].map((id) => {
              const fund = selMeta.fund.filter((f) => f.doc_id === id)
              const anchors = [...new Set(fund.flatMap((f) => f.line ? [f.line] : []))]
              const blatt = fund[0]?.blatt
              return <button key={id} className="btn" title={fund.some((f) => f.unklar) ? 'Fundstelle unklar' : undefined}
                onClick={() => open(id, anchors[0], { anchors })}>
                {id}{blatt ? ` · ${/^(Bl|S)\./.test(blatt) ? blatt : `Bl. ${blatt}`}` : ''} · {anchors.length} {anchors.length === 1 ? 'Stelle' : 'Stellen'}
              </button>
            })}
          </div>
        </aside>
      )}
    </div>
  )
}
