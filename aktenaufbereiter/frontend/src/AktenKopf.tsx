import type { Case, DateValue, Fundstelle } from './api'
import { FundChips } from './components'

type Ansicht = 'geschehen' | 'verfahren' | 'fristen' | 'widersprueche'

function Zelle({ label, wert, text, fund, onClick }: { label: string; wert: string; text?: string; fund?: Fundstelle[]; onClick: () => void }) {
  return (
    <div className="kopf-zelle">
      <button onClick={onClick}>
        <span className="kopf-label">{label}</span>
        <span className="kopf-wert">{wert}</span>
        {text && <span className="kopf-text">{text}</span>}
      </button>
      {!!fund?.length && <div className="kopf-fund"><FundChips items={fund.slice(0, 1)} /></div>}
    </div>
  )
}

const mitIso = <T,>(items: T[], datum: (x: T) => DateValue | null | undefined) =>
  items.filter((x) => datum(x)?.iso).sort((a, b) => datum(a)!.iso!.localeCompare(datum(b)!.iso!))

/** Die Akte auf einen Blick: nur Daten und Zählungen aus der Akte, jeweils mit Weg zur Quelle. */
export function AktenKopf({ data, onAnsicht }: { data: Case; onAnsicht: (v: Ansicht) => void }) {
  const geschehen = mitIso(data.ereignisse.filter((e) => e.kind === 'geschehen'), (e) => e.ereignisdatum)
  const verfahren = mitIso(data.ereignisse.filter((e) => e.kind === 'verfahren'), (e) => e.ereignisdatum)
  const fristen = mitIso(data.fristen, (f) => f.datum)
  const heute = new Date().toISOString().slice(0, 10)
  const naechste = fristen.find((f) => f.datum!.iso!.slice(0, 10) >= heute)
  const frist = naechste ?? fristen.at(-1)
  const letzter = verfahren.at(-1)
  const anzeige = (d?: DateValue | null) => d?.anzeige ?? d?.iso ?? 'Datum unklar'

  return (
    <section className="akten-kopf" aria-label="Akte auf einen Blick">
      <Zelle label="Geschehen" onClick={() => onAnsicht('geschehen')}
        wert={geschehen.length ? `${anzeige(geschehen[0].ereignisdatum)} bis ${anzeige(geschehen.at(-1)!.ereignisdatum)}` : 'Kein Datum in der Akte'}
        text={`${geschehen.length} datierte Ereignisse`} />
      <Zelle label="Letzter Verfahrensschritt" onClick={() => onAnsicht('verfahren')}
        wert={letzter ? anzeige(letzter.ereignisdatum) : 'Kein Datum in der Akte'} text={letzter?.beschreibung} fund={letzter?.fundstellen} />
      <Zelle label={naechste || !frist ? 'Nächste Frist' : 'Letzte Frist'} onClick={() => onAnsicht('fristen')}
        wert={frist ? anzeige(frist.datum) : 'Keine Frist in der Akte'} text={frist?.art} fund={frist?.fundstellen} />
      <Zelle label="Widersprüche" onClick={() => onAnsicht('widersprueche')}
        wert={String(data.widersprueche.length)} text={data.widersprueche.length === 1 ? 'Abweichung dokumentiert' : 'Abweichungen dokumentiert'} />
    </section>
  )
}
