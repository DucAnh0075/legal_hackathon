import { useCallback, useEffect, useMemo, useState } from 'react'
import { Background, Controls, Handle, Position, ReactFlow, type Edge, type Node, type NodeProps, type NodeChange, applyNodeChanges } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from 'd3-force'
import { api, type Case, type Fundstelle } from './api'
import { FundChips } from './components'
import { useDocs } from './ctx'

type NData = { kind: 'person' | 'entity' | 'doc'; title: string; sub?: string; initials?: string; dim: boolean; sel: boolean }

const hidden = { opacity: 0, top: '50%', left: '50%', width: 1, height: 1, minWidth: 0, minHeight: 0, border: 0 }
function CardNode({ data }: NodeProps<Node<NData>>) {
  return (
    <div className={`card ${data.kind} ${data.dim ? 'dim' : ''} ${data.sel ? 'sel' : ''}`}>
      <i className="pin" />
      <Handle type="target" position={Position.Top} style={hidden} isConnectable={false} />
      <Handle type="source" position={Position.Top} style={hidden} isConnectable={false} />
      {data.kind === 'person' && <div className="photo" aria-hidden>{data.initials}</div>}
      <div className="kind">{data.kind === 'person' ? 'Person' : data.kind === 'doc' ? 'Beweismittel' : data.sub}</div>
      <div className="nm">{data.title}</div>
      {data.kind !== 'entity' && data.sub && <div className="sub">{data.sub}</div>}
    </div>
  )
}
const nodeTypes = { card: CardNode }

type Meta = { id: string; kind: NData['kind']; title: string; sub?: string; docs: string[]; fund: Fundstelle[]; text?: string; rest?: string }

export function Board({ data }: { data: Case }) {
  const { caseId, open } = useDocs()
  const [show, setShow] = useState({ person: true, entity: true, doc: true, threads: false })
  const [tk, setTk] = useState('')
  const [sel, setSel] = useState<string | null>(null)
  const [nodes, setNodes] = useState<Node<NData>[]>([])
  const [layout, setLayout] = useState<Record<string, { x: number; y: number }>>({})
  const [saved, setSaved] = useState<Record<string, { x: number; y: number }> | null>(null)

  // Metadaten aller möglichen Karten
  const metas = useMemo(() => {
    const m = new Map<string, Meta>()
    data.personen.forEach((p) => m.set(p.id, { id: p.id, kind: 'person', title: p.name, sub: p.rollen.join(', '), docs: p.fundstellen.map((f) => f.doc_id), fund: p.fundstellen,
      text: p.adresse, rest: p.aliases.length ? `auch: ${p.aliases.join(', ')}` : undefined }))
    data.entitaeten.forEach((e) => m.set(e.id, { id: e.id, kind: 'entity', title: e.label, sub: e.typ, docs: e.fundstellen.map((f) => f.doc_id), fund: e.fundstellen, text: e.details ?? undefined }))
    data.dokumente.forEach((d) => m.set(d.id, { id: d.id, kind: 'doc', title: d.id, sub: `${d.title || d.doc_type} · Bl. ${d.blatt_von}`, docs: [d.id],
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
    data.beziehungen.forEach((r) => visible.has(r.von) && visible.has(r.zu) && out.push({ id: r.id, source: r.von, target: r.zu, type: 'straight', label: r.beziehung }))
    data.widersprueche.forEach((w) => {
      const docs = [...new Set(w.varianten.flatMap((v) => v.fundstellen.map((f) => f.doc_id)))].filter((d) => visible.has(d))
      for (let i = 0; i < docs.length - 1; i++) out.push({ id: `${w.id}-${i}`, source: docs[i], target: docs[i + 1], type: 'straight', label: `Widerspruch: ${w.thema}`.slice(0, 48), className: 'contra' })
    })
    if (show.threads) {
      metas.forEach((m) => {
        if (m.kind === 'doc' || !visible.has(m.id)) return
        new Set(m.docs).forEach((d) => visible.has(d) && out.push({ id: `${m.id}~${d}`, source: d, target: m.id, type: 'straight', className: 'thin' }))
      })
    }
    return out
  }, [data, visible, show.threads, metas])

  // gespeicherte Positionen laden
  useEffect(() => { api.get(caseId).then((d) => setSaved(d.layout)).catch(() => setSaved({})) }, [caseId])

  // Erstlayout per Kräftesimulation (nur für Karten ohne gespeicherte Position)
  useEffect(() => {
    if (!saved) return
    const ids = [...visible]
    const sim = ids.map((id, i) => ({ id, x: Math.cos(i) * 300, y: Math.sin(i) * 300 } as { id: string; x: number; y: number }))
    const idx = new Map(sim.map((s) => [s.id, s]))
    const links = edges.filter((e) => idx.has(e.source) && idx.has(e.target)).map((e) => ({ source: e.source, target: e.target, w: e.className === 'thin' ? 0.15 : 1 }))
    const s = forceSimulation(sim).force('link', forceLink(links).id((d) => (d as { id: string }).id).distance((l) => ((l as { w: number }).w < 1 ? 220 : 170)).strength((l) => (l as { w: number }).w * 0.5))
      .force('charge', forceManyBody().strength(-520)).force('collide', forceCollide(112)).force('x', forceX(0).strength(0.09)).force('y', forceY(0).strength(0.12)).stop()
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
    setNodes([...visible].map((id) => {
      const m = metas.get(id)!
      return { id, type: 'card', position: layout[id] ?? { x: 0, y: 0 }, draggable: true,
        data: { kind: m.kind, title: m.title, sub: m.sub, initials: m.kind === 'person' ? m.title.split(/\s+/).map((w) => w[0]).slice(0, 2).join('') : undefined, dim: !!near && !near.has(id), sel: sel === id } }
    }))
  }, [visible, metas, layout, near, sel])

  const onNodesChange = useCallback((c: NodeChange<Node<NData>>[]) => setNodes((n) => applyNodeChanges(c, n)), [])
  const styled = useMemo(() => edges.map((e) => (near && !(near.has(e.source) && near.has(e.target) && (e.source === sel || e.target === sel)) ? { ...e, className: `${e.className ?? ''} dim` } : e)), [edges, near, sel])

  const selMeta = sel ? metas.get(sel) : null
  const links = sel ? edges.filter((e) => (e.source === sel || e.target === sel) && e.className !== 'thin') : []

  return (
    <div className="boardwrap cork">
      <ReactFlow key={`${tk}|${[...visible].join()}|${Object.keys(layout).length ? 'ready' : 'wait'}`} nodes={nodes} edges={styled} nodeTypes={nodeTypes} onNodesChange={onNodesChange} fitView fitViewOptions={{ padding: 0.15, maxZoom: 1 }} minZoom={0.15} maxZoom={1.8}
        onNodeClick={(_, n) => setSel(n.id === sel ? null : n.id)} onPaneClick={() => setSel(null)}
        onNodeDoubleClick={(_, n) => metas.get(n.id)?.kind === 'doc' && open(n.id)}
        onNodeDragStop={(_, n) => { const next = { ...layout, ...Object.fromEntries(nodes.map((x) => [x.id, x.position])), [n.id]: n.position }; setLayout(next); setSaved(next); api.saveLayout(caseId, next) }}
        edgeTypes={{}} proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{ labelBgPadding: [6, 3], labelBgBorderRadius: 3 }}>
        <Background gap={40} size={0} />
        <Controls showInteractive={false} />
      </ReactFlow>

      <div className="boardbar">
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
            {selMeta.kind === 'doc' ? <button className="btn primary" onClick={() => open(selMeta.id)}>Datei öffnen</button> : <FundChips items={selMeta.fund} />}
          </div>
        </aside>
      )}
    </div>
  )
}
