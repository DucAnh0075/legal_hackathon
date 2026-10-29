import { useCallback, useEffect, useMemo, useState } from 'react'
import { BaseEdge, EdgeLabelRenderer, getStraightPath, type EdgeProps, Background, Controls, Handle, Position, ReactFlow, type Edge, type Node, type NodeProps, type NodeChange, applyNodeChanges } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from 'd3-force'
import { api, type Case, type Fundstelle } from './api'
import { useDocs } from './ctx'

const HIDDEN_ENTITIES = /^(objekt|sonstiges|profil)$/i
const AUTHORITIES = /^(gericht|behoerde|behörde)$/i
const PROSECUTION = /staatsanwaltschaft/i
const JUDGES = /richter/i
const JUSTICE_STAFF = /urkundsbeamt|geschäftsstelle|justiz|zusteller|postbedienst|servicekraft|serviceeinheit|wachtmeist|protokollführ|rechtspfleger/i
const PARTICIPANTS = /zeug|beschuldigt|angeklagt|angeschuldigt|geschädigt|anzeig|kläger|beklagt|verteidig|anwalt|staatsanw|geschäftsführ/i
const PROCEDURAL_DOCS = /aktendeckel|zählblatt|pebb|\bklage|klageerwiderung|replik|duplik|schriftsatz|anwaltsschreiben|verfügung|beschluss|ladung|zustellungsurkunde|\bzustellung|anklageschrift|haftbefehl|gesetz|formular|arbeitshilfe|terminbestimmung|urteil/i

type Point = { x: number; y: number }
type Positions = Record<string, Point>
type Thread = Edge<{ labelPos?: Point; dim?: boolean; contra?: boolean; thin?: boolean; onSelect?: () => void }>

function ThreadEdge(props: EdgeProps<Thread>) {
  const [path, x, y] = getStraightPath(props)
  const { data, label } = props
  const text = String(label ?? '')
  const pos = data?.labelPos ?? { x, y }
  return <>
    <BaseEdge id={props.id} path={path} style={props.style} markerEnd={props.markerEnd} markerStart={props.markerStart} />
    {text && !data?.thin && <EdgeLabelRenderer>
      <div className={`thread-label nodrag nopan${data?.dim ? ' dim' : ''}${data?.contra ? ' contra' : ''}`}
        style={{ transform: `translate(-50%,-50%) translate(${pos.x}px,${pos.y}px)` }} title={text} role="button" tabIndex={0}
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
  if (layout._v !== 2) return {}
  return Object.fromEntries(Object.entries(layout).filter((entry): entry is [string, Point] => {
    const [id, p] = entry
    return id !== '_v' && !!p && typeof p === 'object' && 'x' in p && 'y' in p && typeof p.x === 'number' && typeof p.y === 'number' && Number.isFinite(p.x) && Number.isFinite(p.y)
  }))
}

type NData = { kind: 'person' | 'entity' | 'doc'; title: string; sub?: string; initials?: string; dim: boolean; sel: boolean; suspect: boolean; basis?: string }

const hidden = { opacity: 0, top: '50%', left: '50%', width: 1, height: 1, minWidth: 0, minHeight: 0, border: 0 }
function CardNode({ data }: NodeProps<Node<NData>>) {
  return (
    <div className={`card ${data.kind} ${data.dim ? 'dim' : ''} ${data.sel ? 'sel' : ''} ${data.suspect ? 'suspect' : ''}`} title={data.basis}>
      <i className="pin" />
      <Handle type="target" position={Position.Top} style={hidden} isConnectable={false} />
      <Handle type="source" position={Position.Top} style={hidden} isConnectable={false} />
      {data.kind === 'person' && <div className="photo" aria-hidden>{data.initials}</div>}
      <div className="kind">{data.kind === 'person' ? 'Person' : data.kind === 'doc' ? 'Beweismittel' : data.sub}{data.suspect && <span className="suspect-tag">Hauptverdächtig</span>}</div>
      <div className="nm">{data.title}</div>
      {data.kind !== 'entity' && data.sub && <div className="sub">{data.sub}</div>}
    </div>
  )
}
const nodeTypes = { card: CardNode }

type Meta = { id: string; kind: NData['kind']; title: string; sub?: string; docs: string[]; fund: Fundstelle[]; text?: string; rest?: string }

export function Board({ data, suspects, onSuspects }: { data: Case; suspects: Record<string, boolean>; onSuspects: (next: Record<string, boolean>) => void }) {
  const { caseId, open } = useDocs()
  const [show, setShow] = useState({ person: true, entity: true, doc: true, threads: false })
  const [tk, setTk] = useState('')
  const [sel, setSel] = useState<string | null>(null)
  const [nodes, setNodes] = useState<Node<NData>[]>([])
  const [layout, setLayout] = useState<Positions>({})
  const [saved, setSaved] = useState<Positions | null>(null)

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const isSuspect = (id: string) => suspects[id] ?? !!data.personen.find((p) => p.id === id)?.rollen.some((r) => /beschuldigt|angeklagt|angeschuldigt|tatverdächtig/i.test(r))

  // Metadaten aller möglichen Karten
  const metas = useMemo(() => {
    const m = new Map<string, Meta>()
    data.personen.filter((p) => !p.rollen.some((r) => JUDGES.test(r)) && !(p.rollen.length > 0 && p.rollen.every((r) => JUSTICE_STAFF.test(r)) && !p.rollen.some((r) => PARTICIPANTS.test(r)))).forEach((p) => m.set(p.id, { id: p.id, kind: 'person', title: p.name, sub: p.rollen.join(', '), docs: p.fundstellen.map((f) => f.doc_id), fund: p.fundstellen,
      text: p.adresse, rest: p.aliases.length ? `auch: ${p.aliases.join(', ')}` : undefined }))
    data.entitaeten.filter((e) => !HIDDEN_ENTITIES.test(e.typ) && (!AUTHORITIES.test(e.typ) || PROSECUTION.test(e.label))).forEach((e) => m.set(e.id, { id: e.id, kind: 'entity', title: e.label, sub: e.typ, docs: e.fundstellen.map((f) => f.doc_id), fund: e.fundstellen, text: e.details ?? undefined }))
    data.dokumente.filter((d) => !PROCEDURAL_DOCS.test(d.doc_type) && !PROCEDURAL_DOCS.test(d.title)).forEach((d) => m.set(d.id, { id: d.id, kind: 'doc', title: d.id, sub: `${d.title || d.doc_type} · Bl. ${d.blatt_von}`, docs: [d.id],
      fund: [{ doc_id: d.id, blatt: `Bl. ${d.blatt_von}`, unklar: false }], text: d.essentialia }))
    return m
  }, [data])

  // sichtbare Karten nach Filtern
  const visible = useMemo(() => {
    const t = data.tatkomplexe.find((x) => x.id === tk)
    let ids = [...metas.keys()]
    if (t) {
      const docs = new Set(t.beweismittel)
      ids = ids.filter((id) => {
        const m = metas.get(id)!
        return m.kind === 'doc' ? docs.has(id) : m.kind === 'person' ? t.personen.includes(id) : m.docs.some((d) => docs.has(d))
      })
    }
    return new Set(ids.filter((id) => show[metas.get(id)!.kind]))
  }, [metas, tk, show, data.tatkomplexe])

  // Kanten: Beziehungen (roter Faden), Widersprüche (gestrichelt), Fundstellen (dünn)
  const edges = useMemo(() => {
    const out: Edge[] = []
    data.beziehungen.forEach((r) => visible.has(r.von) && visible.has(r.zu) && out.push({ id: r.id, source: r.von, target: r.zu, type: 'thread', label: r.beziehung }))
    data.widersprueche.forEach((w) => {
      const docs = [...new Set(w.varianten.flatMap((v) => v.fundstellen.map((f) => f.doc_id)))].filter((d) => visible.has(d))
      for (let i = 0; i < docs.length - 1; i++) out.push({ id: `${w.id}-${i}`, source: docs[i], target: docs[i + 1], type: 'thread', label: `Widerspruch: ${w.thema}`, className: 'contra' })
    })
    if (show.threads) {
      metas.forEach((m) => {
        if (m.kind === 'doc' || !visible.has(m.id)) return
        new Set(m.docs).forEach((d) => visible.has(d) && out.push({ id: `${m.id}~${d}`, source: d, target: m.id, type: 'thread', className: 'thin' }))
      })
    }
    return out
  }, [data, visible, show.threads, metas])

  // gespeicherte Positionen laden
  useEffect(() => { api.get(caseId).then((d) => setSaved(readLayout(d.layout))).catch(() => setSaved({})) }, [caseId])

  // Erstlayout per Kräftesimulation (nur für Karten ohne gespeicherte Position)
  useEffect(() => {
    if (!saved) return
    const ids = [...visible]
    const sim = ids.map((id, i) => ({ id, x: Math.cos(i) * 300, y: Math.sin(i) * 300 } as { id: string; x: number; y: number }))
    const idx = new Map(sim.map((s) => [s.id, s]))
    const links = edges.filter((e) => idx.has(e.source) && idx.has(e.target)).map((e) => ({ source: e.source, target: e.target, w: e.className === 'thin' ? 0.15 : 1 }))
    const s = forceSimulation(sim).force('link', forceLink(links).id((d) => (d as { id: string }).id).distance((l) => ((l as { w: number }).w < 1 ? 340 : 300)).strength((l) => (l as { w: number }).w * 0.5))
      .force('charge', forceManyBody().strength(-1600)).force('collide', forceCollide(150)).force('x', forceX(0).strength(0.05)).force('y', forceY(0).strength(0.07)).stop()
    for (let i = 0; i < 400; i++) s.tick()
    const pos: Record<string, { x: number; y: number }> = {}
    sim.forEach((n) => { pos[n.id] = saved[n.id] ?? { x: Math.round(n.x), y: Math.round(n.y) } })
    setLayout(pos)
  }, [visible, edges, saved])

  // Nachbarn der Auswahl
  const near = useMemo(() => {
    if (!sel) return null
    const s = new Set([sel])
    edges.forEach((e) => { if (e.source === sel) s.add(e.target); if (e.target === sel) s.add(e.source) })
    return s
  }, [sel, edges])

  useEffect(() => {
    setNodes((previous) => [...visible].map((id) => {
      const m = metas.get(id)!
      return { id, measured: previous.find((n) => n.id === id)?.measured, type: 'card', position: layout[id] ?? { x: 0, y: 0 }, draggable: true,
        data: { suspect: m.kind === 'person' && isSuspect(id), basis: m.kind === 'person' && isSuspect(id) ? (suspects[id] === true ? 'manuell markiert' : `Rolle laut Akte: ${m.sub}`) : undefined, kind: m.kind, title: m.title, sub: m.sub, initials: m.kind === 'person' ? m.title.split(/\s+/).map((w) => w[0]).slice(0, 2).join('') : undefined, dim: !!near && !near.has(id), sel: sel === id } }
    }))
  }, [visible, metas, layout, near, sel, suspects])

  const onNodesChange = useCallback((c: NodeChange<Node<NData>>[]) => setNodes((n) => applyNodeChanges(c, n)), [])
  const labelPositions = useMemo(() => placeLabels(nodes, edges), [nodes, edges])
  const styled = useMemo(() => edges.map((e): Thread => {
    const dim = !!near && !(near.has(e.source) && near.has(e.target) && (e.source === sel || e.target === sel))
    return { ...e, className: `${e.className ?? ''}${dim ? ' dim' : ''}`, data: {
      labelPos: labelPositions[e.id], dim, contra: e.className === 'contra', thin: e.className === 'thin',
      onSelect: () => setSel(e.target === sel ? e.source : e.target),
    } }
  }), [edges, near, sel, labelPositions])

  const selMeta = sel ? metas.get(sel) : null
  const links = sel ? edges.filter((e) => (e.source === sel || e.target === sel) && e.className !== 'thin') : []

  return (
    <div className="boardwrap cork">
      <ReactFlow key={`${tk}|${[...visible].join()}|${Object.keys(layout).length ? 'ready' : 'wait'}`} nodes={nodes} edges={styled} nodeTypes={nodeTypes} onNodesChange={onNodesChange} fitView fitViewOptions={{ padding: 0.15, maxZoom: 1 }} minZoom={0.15} maxZoom={1.8}
        onNodeClick={(_, n) => setSel(n.id === sel ? null : n.id)} onPaneClick={() => setSel(null)}
        onNodeDoubleClick={(_, n) => metas.get(n.id)?.kind === 'doc' && open(n.id, undefined, { original: true })}
        onNodeDragStop={(_, n) => { const next = { ...layout, ...Object.fromEntries(nodes.map((x) => [x.id, x.position])), [n.id]: n.position }; setLayout(next); setSaved(next); api.saveLayout(caseId, { ...next, _v: 2 }) }}
        edgeTypes={edgeTypes} proOptions={{ hideAttribution: true }}>
        <Background gap={40} size={0} />
        <Controls showInteractive={false} />
      </ReactFlow>

      <div className="boardbar">
        <button className="btn" onClick={() => { setSaved({}); api.saveLayout(caseId, { _v: 2 }) }}>Neu anordnen</button>
        {(['person', 'entity', 'doc'] as const).map((k) => (
          <label key={k} style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
            <input type="checkbox" checked={show[k]} onChange={(e) => setShow({ ...show, [k]: e.target.checked })} />{k === 'person' ? 'Personen' : k === 'entity' ? 'Firmen & Konten' : 'Beweismittel'}
          </label>
        ))}
        <label style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
          <input type="checkbox" checked={show.threads} onChange={(e) => setShow({ ...show, threads: e.target.checked })} />Fundstellen-Fäden
        </label>
        <select value={tk} onChange={(e) => { setTk(e.target.value); setSel(null) }} aria-label="Tatkomplex filtern">
          <option value="">Alle Tatkomplexe</option>
          {data.tatkomplexe.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
      </div>

      {selMeta && (
        <aside className="detail">
          <h3>{selMeta.title}</h3>
          {selMeta.sub && <p>{selMeta.sub}</p>}
          {selMeta.text && <p style={{ color: 'var(--ink)' }}>{selMeta.text}</p>}
          {selMeta.rest && <p>{selMeta.rest}</p>}
          {selMeta.kind === 'person' && <button className="btn" disabled={saving} onClick={async () => {
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
            {selMeta.kind === 'doc' ? <button className="btn primary" onClick={() => open(selMeta.id, undefined, { original: true })}>Datei öffnen</button> : [...new Set(selMeta.fund.map((f) => f.doc_id))].map((id) => {
              const fund = selMeta.fund.filter((f) => f.doc_id === id)
              const anchors = [...new Set(fund.flatMap((f) => f.line ? [f.line] : []))]
              const blatt = fund[0]?.blatt
              return <button key={id} className="btn" title={fund.some((f) => f.unklar) ? 'Fundstelle unklar' : undefined}
                onClick={() => open(id, anchors[0], { anchors, original: true })}>
                {id}{blatt ? ` · ${/^(Bl|S)\./.test(blatt) ? blatt : `Bl. ${blatt}`}` : ''} · {anchors.length} {anchors.length === 1 ? 'Stelle' : 'Stellen'}
              </button>
            })}
          </div>
        </aside>
      )}
    </div>
  )
}
