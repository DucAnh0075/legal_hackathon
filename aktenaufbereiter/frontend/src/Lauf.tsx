import { Check, Circle, TriangleAlert } from 'lucide-react'

type Stand = 'offen' | 'aktiv' | 'fertig' | 'fehler'

/** Leitet die Schritte aus den Meldungen des Agenten ab; andere Läufe (Pool, Sammelakte) bleiben Protokoll. */
function schritte(log: string[], busy: boolean, error: string) {
  const erkannt = log.map((l) => /^(\d+) Aktenstücke erkannt/.exec(l)).find(Boolean)
  const gesamt = erkannt ? Number(erkannt[1]) : null
  const gelesen = log.filter((l) => /^fertig [A-Z]\d+|^[A-Z]\d+ aus Zwischenspeicher/.test(l)).length
  const fehlgeschlagen = log.filter((l) => /^Fehler bei [A-Z]\d+/.test(l)).length
  const liest = log.some((l) => /^liest [A-Z]\d+/.test(l)) || gelesen + fehlgeschlagen > 0
  const konsolidiert = log.some((l) => /^konsolidiert: /.test(l))
  const gespeichert = log.some((l) => l.startsWith('gespeichert ('))
  const begonnen = [log.length > 0, !!erkannt || liest, konsolidiert, gespeichert]
  const zuletzt = begonnen.lastIndexOf(true)
  const stand = (i: number): Stand => {
    if (i > zuletzt) return 'offen'
    if (i < zuletzt || (gespeichert && i === 3)) return 'fertig'
    return error ? 'fehler' : busy ? 'aktiv' : 'fertig'
  }
  return [
    { label: 'Einlesen', detail: gesamt !== null ? `${gesamt} Aktenstücke` : undefined, stand: stand(0) },
    { label: 'Extraktion', detail: gesamt ? `${Math.min(gelesen, gesamt)} von ${gesamt} Aktenstücken${fehlgeschlagen ? `, ${fehlgeschlagen} mit Fehler` : ''}` : undefined, anteil: gesamt ? Math.min((gelesen + fehlgeschlagen) / gesamt, 1) : undefined, stand: stand(1) },
    { label: 'Konsolidierung', stand: stand(2) },
    { label: 'Prüfung und Speichern', stand: stand(3) },
  ]
}

export function Lauf({ log, busy, error }: { log: string[]; busy: boolean; error: string }) {
  const istAufbereitung = log.some((l) => /Aktenstücke erkannt|^gliedert Sammelakte/.test(l))
  return (
    <section className="lauf" aria-label="Agentenlauf">
      {istAufbereitung && (
        <ol className="lauf-schritte">
          {schritte(log, busy, error).map((s) => (
            <li key={s.label} className={`schritt ${s.stand}`} aria-current={s.stand === 'aktiv' ? 'step' : undefined}>
              <span className="schritt-mark" aria-hidden>
                {s.stand === 'aktiv' ? <i className="spinner" /> : s.stand === 'fertig' ? <Check size={14} /> : s.stand === 'fehler' ? <TriangleAlert size={14} /> : <Circle size={8} />}
              </span>
              <span className="schritt-text">
                <b>{s.label}</b>
                {s.detail && <small>{s.detail}</small>}
                {s.anteil !== undefined && s.stand !== 'offen' && <span className="schritt-balken"><i style={{ transform: `scaleX(${s.anteil})` }} /></span>}
              </span>
            </li>
          ))}
        </ol>
      )}
      {error && <p className="err" role="alert">Fehler: {error}</p>}
      {log.length > 0 && (
        <details className="lauf-protokoll" open={!istAufbereitung}>
          <summary>Protokoll</summary>
          <div className="log" role="log" aria-live="polite">{log.map((l, i) => <div key={i}>{l}</div>)}</div>
        </details>
      )}
    </section>
  )
}
