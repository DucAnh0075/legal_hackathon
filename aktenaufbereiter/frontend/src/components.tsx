import type { ReactNode } from 'react'
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
        return (
          <button key={i} className={`chip link ${f.unklar ? 'warn' : ''}`} onClick={() => open(f.doc_id, f.line ?? undefined)}
            title={f.unklar ? 'Fundstelle unklar' : 'Original öffnen'}>
            {f.blatt ? `${f.blatt} · ` : ''}{f.line ?? f.doc_id}{f.unklar ? ' ?' : ''}
          </button>
        )
      })}
    </>
  )
}

/** Zellen mit "Bl. 3 (A01:L04); Bl. 5 (A06)" werden zu klickbaren Chips. */
const PART = /^(.*?)\s*\(([A-Z]\d{2}(?::L\d+)?)\)(\s*\[Fundstelle unklar\])?$/
export function CellContent({ value }: { value: string | number }) {
  const { open } = useDocs()
  if (typeof value !== 'string') return <>{value}</>
  const parts = value.split('; ')
  const matches = parts.map((p) => PART.exec(p))
  if (!parts.length || !matches.every(Boolean)) return <>{value}</>
  return (
    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
      {matches.map((m, i) => {
        const [, blatt, ref, unklar] = m!
        return (
          <button key={i} className={`chip link ${unklar ? 'warn' : ''}`}
            onClick={(e) => { e.stopPropagation(); open(ref.split(':')[0], ref.includes(':') ? ref : undefined) }}>
            {blatt ? `${blatt} · ` : ''}{ref}{unklar ? ' ?' : ''}
          </button>
        )
      })}
    </span>
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
