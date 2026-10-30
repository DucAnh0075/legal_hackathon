import { useMemo, useState } from 'react'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { api, type Table } from './api'
import { CellContent, Page } from './components'
import { useDocs } from './ctx'

const sortKey = (v: string | number) => {
  if (typeof v === 'number') return v
  const m = /^(\d{2})\.(\d{2})\.(\d{4})/.exec(v)
  return m ? `${m[3]}${m[2]}${m[1]}${v.slice(10)}` : v.toLowerCase()
}

export function DataTable({ table, extra, sub, kopf }: { table: Table; extra?: React.ReactNode; sub?: string; kopf?: React.ReactNode }) {
  const { open, caseId } = useDocs()
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null)
  const [sel, setSel] = useState<string | null>(null)

  const rows = useMemo(() => {
    let r = table.rows.filter((x) => !q || x.cells.join(' ').toLowerCase().includes(q.toLowerCase()))
    if (sort) {
      r = [...r].sort((a, b) => {
        const x = sortKey(a.cells[sort.col]), y = sortKey(b.cells[sort.col])
        return (x < y ? -1 : x > y ? 1 : 0) * sort.dir
      })
    }
    return r
  }, [table, q, sort])

  const copy = () => {
    const tsv = [table.cols, ...rows.map((r) => r.cells)].map((r) => r.map((c) => String(c).replace(/\s+/g, ' ')).join('\t')).join('\n')
    navigator.clipboard.writeText(tsv)
  }
  // Kurze Spalten bleiben einzeilig, damit der Text Platz bekommt
  const eng = useMemo(() => table.cols.map((_, i) => table.rows.every((r) => String(r.cells[i] ?? '').replace(/ \(.*\)$/, '').length <= 24)), [table])
  const annField = (c: string) => (c === 'Anmerkung Kanzlei' ? 'kanzlei' : c === 'Anmerkung Mandant' ? 'mandant' : null)

  return (
    <Page title={table.title} sub={sub ?? `${rows.length} Einträge`} tools={
      <>
        <input type="search" placeholder="Filtern …" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Tabelle filtern" />
        {extra}
        <button className="btn" onClick={copy} title="Tabelle als Tab-getrennten Text kopieren, direkt in Excel einfügbar">Für Excel kopieren</button>
        <a className="btn primary" href={api.xlsxUrl(caseId)} style={{ textDecoration: 'none' }}>Excel-Export</a>
      </>
    }>
      {kopf}
      {rows.length === 0 ? (
        <div className="empty">Keine Einträge in der Akte.</div>
      ) : (
        <div className="tablewrap">
          <table className="t">
            <thead>
              <tr>
                {table.cols.map((c, i) => (
                  <th key={i} aria-sort={sort?.col === i ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
                    <button onClick={() => setSort(sort?.col === i && sort.dir === 1 ? { col: i, dir: -1 } : { col: i, dir: 1 })}>
                      {c}{sort?.col === i && (sort.dir === 1 ? <ArrowUp size={12} aria-hidden /> : <ArrowDown size={12} aria-hidden />)}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={`row ${sel === r.id ? 'sel' : ''}`}
                  onClick={() => { setSel(r.id); if (r.doc) open(r.doc) }}>
                  {r.cells.map((c, i) => {
                    const f = annField(table.cols[i])
                    return f ? (
                      <td key={i} className="ann" onClick={(e) => e.stopPropagation()}>
                        <textarea defaultValue={String(c)} rows={1} aria-label={table.cols[i]}
                          onBlur={(e) => { if (e.target.value !== String(c)) api.annotate(caseId, r.id.replace(/-\d+$/, ''), f, e.target.value) }} />
                      </td>
                    ) : (
                      <td key={i} className={eng[i] ? 'eng' : undefined}>
                        {typeof c === 'string' && c.length > 220 ? <div className="zelle-lang"><CellContent value={c} /></div> : <CellContent value={c} />}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Page>
  )
}
