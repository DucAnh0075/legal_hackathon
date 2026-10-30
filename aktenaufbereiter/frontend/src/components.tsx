import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { Fundstelle } from './api'
import { useDocs } from './ctx'

export const STATUS_LABEL: Record<string, string> = { belegt: 'belegt', aussage: 'Aussage', korrektur: 'Korrektur', offen: 'offen' }

export function StatusChip({ status }: { status: string }) {
  return (
    <span className={`chip s-${status}`}>
      <i className="dot" style={{ background: 'var(--c)' }} />
      {STATUS_LABEL[status] ?? status}
    </span>
  )
}

export function FundChips({ items }: { items: Fundstelle[] }) {
  const { open } = useDocs()
  const seen = new Set<string>()
  return (
    <>
      {items.map((f, i) => {
        const key = `${f.doc_id}:${f.line ?? ''}`
        if (seen.has(key)) return null
        seen.add(key)
        return <FundMarke key={i} docId={f.doc_id} anker={f.line ?? undefined} blatt={f.blatt} unklar={f.unklar} onClick={() => open(f.doc_id, f.line ?? undefined)} />
      })}
    </>
  )
}

let zuletztGeschlossen = 0

/** Fundstelle als Aktenmarke; beim Überfahren oder Fokus zeigt sie die Aktenzeile. */
function FundMarke({ docId, anker, blatt, unklar, onClick }: { docId: string; anker?: string; blatt?: string | null; unklar: boolean; onClick: React.MouseEventHandler<HTMLButtonElement> }) {
  const { dokumente } = useDocs()
  const [ort, setOrt] = useState<{ x: number; y: number; oben: boolean; sofort: boolean } | null>(null)
  const timer = useRef(0)
  const id = useId()
  const doc = dokumente.find((d) => d.id === docId)
  const zeile = anker ? doc?.text_lines.find((l) => l.anchor === anker)?.text : undefined
  const hatVorschau = !!(doc && (zeile || doc.title))

  const zeigen = (el: HTMLElement) => {
    if (!hatVorschau) return
    const r = el.getBoundingClientRect()
    const sofort = Date.now() - zuletztGeschlossen < 400 // Nachbarmarken ohne erneute Wartezeit
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setOrt({ x: Math.max(8, Math.min(r.left, innerWidth - 368)), y: r.top > 150 ? r.top - 6 : r.bottom + 6, oben: r.top > 150, sofort }), sofort ? 0 : 300)
  }
  const verbergen = () => {
    window.clearTimeout(timer.current)
    setOrt((o) => { if (o) zuletztGeschlossen = Date.now(); return null })
  }
  useEffect(() => {
    if (!ort) return
    window.addEventListener('scroll', verbergen, true)
    return () => window.removeEventListener('scroll', verbergen, true)
  }, [ort])
  useEffect(() => () => window.clearTimeout(timer.current), [])

  return (
    <>
      <button className={`chip link ${unklar ? 'warn' : ''}`} aria-describedby={ort ? id : undefined} title={unklar ? 'Fundstelle unklar' : undefined}
        onClick={(e) => { verbergen(); onClick(e) }}
        onPointerEnter={(e) => { if (e.pointerType === 'mouse') zeigen(e.currentTarget) }} onPointerLeave={verbergen}
        onFocus={(e) => { if (e.currentTarget.matches(':focus-visible')) zeigen(e.currentTarget) }} onBlur={verbergen}
        onKeyDown={(e) => { if (e.key === 'Escape') verbergen() }}>
        {blatt ? `${blatt} · ` : ''}{anker ?? docId}{unklar ? ' ?' : ''}
      </button>
      {ort && createPortal(
        <div id={id} role="tooltip" className={`fund-vorschau ${ort.oben ? 'oben' : ''} ${ort.sofort ? 'sofort' : ''}`} style={{ left: ort.x, top: ort.y }}>
          <span className="fund-titel">{docId}{doc?.title ? ` · ${doc.title}` : ''}</span>
          {zeile && <p>{zeile}</p>}
        </div>, document.body)}
    </>
  )
}

/** Datum mit Hinweis in Klammern: Der Hinweis bleibt sichtbar, macht die Spalte aber nicht breit. */
const DATUM_HINWEIS = /^(\d{2}\.\d{2}\.\d{4}(?: \d{2}:\d{2})?) \((.+)\)$/

/** Zellen mit "Bl. 3 (A01:L04); Bl. 5 (A06)" werden zu klickbaren Chips. */
const PART = /^(.*?)\s*\(([A-Z]\d{2}(?::L\d+)?)\)(\s*\[Fundstelle unklar\])?$/
export function CellContent({ value }: { value: string | number }) {
  const { open } = useDocs()
  if (typeof value !== 'string') return <>{value}</>
  const datum = DATUM_HINWEIS.exec(value)
  if (datum) return <>{datum[1]}<small className="datum-hinweis">{datum[2]}</small></>
  const parts = value.split('; ')
  const matches = parts.map((p) => PART.exec(p))
  if (!parts.length || !matches.every(Boolean)) return <>{value}</>
  return (
    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
      {matches.map((m, i) => {
        const [, blatt, ref, unklar] = m!
        const anker = ref.includes(':') ? ref : undefined
        return <FundMarke key={i} docId={ref.split(':')[0]} anker={anker} blatt={blatt} unklar={!!unklar}
          onClick={(e) => { e.stopPropagation(); open(ref.split(':')[0], anker) }} />
      })}
    </span>
  )
}

function foldGelesen(id: string, fallback: boolean) {
  try {
    const v = localStorage.getItem(`fold:${id}`)
    return v === null ? fallback : v === '1'
  } catch { return fallback }
}

/** Auf- und zuklappbarer Bereich; der Zustand überlebt das Öffnen einer Akte. */
export function Fold({ id, title, action, defaultOpen = true, forceOpen = false, className = '', onContextMenu, children }: { id: string; title: ReactNode; action?: ReactNode; defaultOpen?: boolean; forceOpen?: boolean; className?: string; onContextMenu?: React.MouseEventHandler<HTMLElement>; children: ReactNode }) {
  const [open, setOpen] = useState(() => foldGelesen(id, defaultOpen))
  const toggle = (e: React.SyntheticEvent<HTMLDetailsElement>) => {
    if (forceOpen) return // etwa während einer Suche: der eigene Klappzustand bleibt
    const next = e.currentTarget.open
    setOpen(next)
    try { localStorage.setItem(`fold:${id}`, next ? '1' : '0') } catch { /* nur Komfort */ }
  }
  return (
    <div className={`fold ${className}`}>
      <details open={forceOpen || open} onToggle={toggle}>
        <summary onContextMenu={onContextMenu}>
          <svg className="chev" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
          {title}
        </summary>
        <div className="fold-body">{children}</div>
      </details>
      {action && <div className="fold-action">{action}</div>}
    </div>
  )
}

/** Platzhalter, während eine Akte lädt. */
export function Ladeflaeche() {
  return (
    <div className="page ladeflaeche" role="status" aria-label="Akte wird geladen">
      <div className="skelett skelett-titel" />
      <div className="skelett-tabelle">
        {[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="skelett skelett-zeile" />)}
      </div>
    </div>
  )
}

export function Page({ title, sub, tools, children }: { title: string; sub?: string; tools?: ReactNode; children: ReactNode }) {
  return (
    <div className="page">
      <header>
        <h1>{title}</h1>
        {sub && <span className="sub">{sub}</span>}
        {tools && <div className="toolbar">{tools}</div>}
      </header>
      {children}
    </div>
  )
}
