import { Fragment, useEffect, useRef, useState } from 'react'
import { api, type ExternAbruf, type ExternBericht, type ExternIdee, type ExternStand, type Fundstelle } from './api'
import { Fold, FundChips, Page } from './components'

const DATENART: Record<string, string> = {
  wetter: 'Wetter', zeitzone: 'Zeitzonen', licht: 'Licht und Dämmerung', flugwetter: 'Flugwetter', kalender: 'Kalender', kurs: 'Wechselkurs', domain: 'Domain', webarchiv: 'Webarchiv',
}
const FELD: Record<string, string> = {
  ort: 'Ort', land: 'Land', datum: 'Datum', uhrzeit: 'Uhrzeit', icao: 'Flughafen (ICAO)', bundesland: 'Bundesland', domain: 'Domain', waehrung: 'Währung',
}
const ZEIT_SPALTEN = ['Ort', 'Datum', 'Uhrzeit', 'Zeitzone', 'UTC-Versatz', 'UTC', 'Deutschland', 'Zeitbezug']

const zeitpunkt = (iso: string) => new Date(iso).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' })
const datum = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) ? v.split('-').reverse().join('.') : v
const parameter = (a: ExternAbruf) => Object.values(a.parameter).map(datum).join(' · ')
const chips = (anker: string[]): Fundstelle[] => anker.map((x) => ({ doc_id: x.split(':')[0], line: x, unklar: false }))
const feldTyp = (k: string) => (k === 'datum' ? 'date' : k === 'uhrzeit' ? 'time' : 'text')

function Herkunft({ a }: { a: ExternAbruf }) {
  return a.herkunft === 'akte' && a.fundstellen.length > 0 ? <FundChips items={a.fundstellen} /> : <span className="sub">aus der Eingabe</span>
}

function Werte({ a }: { a: ExternAbruf }) {
  return (
    <dl className={a.tool === 'flugwetter' ? 'metar' : ''}>
      {a.werte.map((w, i) => (
        <div key={i}>
          <dt>{w.label}</dt>
          <dd>{w.link ? <a className="text-link" href={w.link} target="_blank" rel="noreferrer">{w.wert}</a> : w.wert}</dd>
        </div>
      ))}
    </dl>
  )
}

function AbrufLink({ a }: { a: ExternAbruf }) {
  return (
    <p className="extern-link">
      <a className="text-link" href={a.url!} target="_blank" rel="noreferrer">{a.url}</a>
      {a.abgerufen_am && <small className="sub">abgerufen {zeitpunkt(a.abgerufen_am)}</small>}
    </p>
  )
}

function Eintrag({ a }: { a: ExternAbruf }) {
  return (
    <article className="extern">
      <div className="extern-kopf">
        <span>{parameter(a)}</span>
        <Herkunft a={a} />
      </div>
      <div className="extern-quelle">
        {a.status === 'ok' ? <Werte a={a} /> : <p className={a.status === 'fehler' ? 'hint' : 'sub'}>{a.grund ?? 'Kein Ergebnis'}</p>}
        {a.quelle && <h4>{a.quelle}</h4>}
        {a.hinweis && <p className="sub">{a.hinweis}</p>}
        {a.url && <AbrufLink a={a} />}
      </div>
    </article>
  )
}

function Zeitzonen({ abrufe }: { abrufe: ExternAbruf[] }) {
  const ok = abrufe.filter((a) => a.status === 'ok')
  const rest = abrufe.filter((a) => a.status !== 'ok')
  const quellen = [...new Set(abrufe.map((a) => a.quelle).filter(Boolean))]
  return (
    <>
      {ok.length > 0 && (
        <div className="tablewrap">
          <table className="t">
            <thead><tr>{[...ZEIT_SPALTEN, 'Herkunft'].map((c) => <th key={c}>{c}</th>)}</tr></thead>
            <tbody>
              {ok.map((a, i) => (
                <tr key={i}>
                  {ZEIT_SPALTEN.map((c) => <td key={c}>{a.werte.find((w) => w.label === c)?.wert ?? '—'}</td>)}
                  <td><Herkunft a={a} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rest.map((a, i) => <p key={i} className={a.status === 'fehler' ? 'hint' : 'sub'}>{parameter(a)}: {a.grund ?? 'Kein Ergebnis'}</p>)}
      {quellen.length > 0 && <p className="sub">{quellen.join(', ')}</p>}
      {ok.filter((a) => a.url).map((a, i) => <AbrufLink key={i} a={a} />)}
    </>
  )
}

function Bericht({ b, offen, onEntfernen }: { b: ExternBericht; offen: boolean; onEntfernen: () => void }) {
  const verworfen = b.abrufe.filter((a) => a.status === 'verworfen')
  const sichtbar = b.abrufe.filter((a) => a.status !== 'verworfen')
  const tools = [...Object.keys(DATENART), ...sichtbar.map((a) => a.tool).filter((t) => !(t in DATENART))]
  return (
    <Fold id={`extern:${b.id}`} className="section" defaultOpen={offen} title={<h2>Bericht vom {zeitpunkt(b.erstellt_am)}</h2>}
      action={<button className="btn ghost" onClick={onEntfernen}>Entfernen</button>}>
      {b.anfrage && <p className="sub extern-bezug">{b.anfrage}</p>}
      {b.hinweis && <p className="sub extern-bezug">{b.hinweis}</p>}
      {[...new Set(tools)].map((t) => {
        const liste = sichtbar.filter((a) => a.tool === t)
        if (!liste.length) return null
        return (
          <section key={t} className="extern-art">
            <h3>{DATENART[t] ?? t}</h3>
            {t === 'zeitzone' ? <Zeitzonen abrufe={liste} /> : liste.map((a, i) => <Eintrag key={i} a={a} />)}
          </section>
        )
      })}
      {verworfen.length > 0 && (
        <div className="extern-verworfen">
          <h4>Nicht abgerufen</h4>
          <ul>{verworfen.map((a, i) => <li key={i}>{DATENART[a.tool] ?? a.tool} {parameter(a)}: {a.grund}</li>)}</ul>
        </div>
      )}
    </Fold>
  )
}

type Ideen = { zustand: 'laedt' | 'fehler' | 'bereit'; liste: ExternIdee[] }

export function Extern({ caseId }: { caseId: string }) {
  const [stand, setStand] = useState<ExternStand | null>(null)
  const [ideen, setIdeen] = useState<Ideen>({ zustand: 'laedt', liste: [] })
  const [gewaehlt, setGewaehlt] = useState<Set<string>>(new Set())
  const [eingabe, setEingabe] = useState<Record<string, Record<string, string>>>({}) // `${ideeId}:${i}` -> geänderte Parameter
  const [entfernt, setEntfernt] = useState<Set<string>>(new Set())
  const [text, setText] = useState('')
  const [meldung, setMeldung] = useState('')
  const [fehler, setFehler] = useState('')
  const [startet, setStartet] = useState(false)
  const quelle = useRef<EventSource | null>(null)

  const laden = () => api.extern(caseId).then(setStand).catch((e) => setFehler(`Daten konnten nicht geladen werden: ${e}`))
  const ideenLaden = () => {
    setIdeen({ zustand: 'laedt', liste: [] })
    api.externIdeen(caseId).then((r) => setIdeen({ zustand: 'bereit', liste: r.ideen })).catch(() => setIdeen({ zustand: 'fehler', liste: [] }))
  }
  useEffect(() => {
    setGewaehlt(new Set()); setEingabe({}); setEntfernt(new Set()); setText('')
    laden(); ideenLaden()
    return () => quelle.current?.close()
  }, [caseId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Ein Lauf arbeitet weiter, wenn der Reiter verlassen wird; nach der Rückkehr bis zum Ende nachladen
  const laeuft = !!stand?.laeuft
  useEffect(() => {
    if (!laeuft || quelle.current) return
    const t = setInterval(laden, 3000)
    return () => clearInterval(t)
  }, [laeuft]) // eslint-disable-line react-hooks/exhaustive-deps

  const schalten = (id: string) => setGewaehlt((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const werte = (i: ExternIdee, n: number) => ({ ...i.abfragen[n].parameter, ...eingabe[`${i.id}:${n}`] })
  const geaendert = (i: ExternIdee, n: number) => {
    const e = eingabe[`${i.id}:${n}`]
    return !!e && Object.entries(e).some(([k, v]) => v !== (i.abfragen[n].parameter[k] ?? ''))
  }
  const setzen = (i: ExternIdee, n: number, k: string, v: string) => setEingabe((s) => ({ ...s, [`${i.id}:${n}`]: { ...s[`${i.id}:${n}`], [k]: v } }))

  const auswahl = ideen.liste.filter((i) => gewaehlt.has(i.id)).flatMap((i) =>
    i.abfragen.map((_, n) => ({ i, n })).filter(({ i, n }) => !entfernt.has(`${i.id}:${n}`)).map(({ i, n }) => ({
      tool: i.art,
      parameter: Object.fromEntries(Object.entries(werte(i, n)).filter(([, v]) => v.trim() !== '')),
      anker: geaendert(i, n) ? [] : i.abfragen[n].anker,
    })))

  const abrufen = async () => {
    setStartet(true); setFehler(''); setMeldung('')
    try {
      const { job } = await api.externAbruf(caseId, auswahl, text.trim())
      setStand((s) => ({ berichte: s?.berichte ?? [], laeuft: true }))
      const es = new EventSource(`/api/jobs/${job}/events`)
      quelle.current = es
      const ende = (ok: boolean) => {
        es.close(); quelle.current = null; laden()
        if (ok) { setGewaehlt(new Set()); setEingabe({}); setEntfernt(new Set()); setText('') }
      }
      es.onmessage = (m) => {
        const ev = JSON.parse(m.data)
        if (ev.msg) setMeldung(ev.msg)
        if (ev.error) { setFehler(`Abruf fehlgeschlagen: ${ev.error}`); ende(false) }
        if (ev.done) ende(true)
      }
      es.onerror = () => { setFehler('Verbindung zum Agenten unterbrochen.'); ende(false) }
    } catch (e) { setFehler(`Abruf nicht gestartet: ${e}`) }
    finally { setStartet(false) }
  }

  const entfernen = (id: string) => api.externEntfernen(caseId, id).then(laden).catch((e) => setFehler(`Bericht konnte nicht entfernt werden: ${e}`))

  const busy = startet || laeuft
  const berichte = stand?.berichte ?? []
  return (
    <Page title="Externe Daten" sub="Nicht Akteninhalt">
      <div className="extern-seite">
        <p className="sub extern-intro">Neutraler Bericht mit Daten von außerhalb der Akte. Der Agent schlägt nur mögliche Daten vor, die Auswahl treffen Sie. Gesendet werden nur Gemeinde, Datum, Flughafen, Domain und Währung, nie Namen oder Adressen.</p>

        <section className="extern-wahl">
          <h2>Mögliche Daten</h2>
          {ideen.zustand === 'laedt' && <p className="sub"><i className="spinner" aria-hidden /> Agent schätzt die Akte ein …</p>}
          {ideen.zustand === 'fehler' && (
            <p className="sub">Einschätzung nicht verfügbar. Eine eigene Anfrage ist weiter möglich. <button className="btn" onClick={ideenLaden}>Erneut versuchen</button></p>
          )}
          {ideen.zustand === 'bereit' && ideen.liste.length === 0 && <p className="sub">Die Akte enthält keine konkreten Anhaltspunkte. Eine eigene Anfrage ist möglich.</p>}
          {ideen.liste.map((i) => {
            const an = gewaehlt.has(i.id)
            return (
              <div key={i.id} className="extern-idee">
                <label className="extern-idee-kopf">
                  <input type="checkbox" checked={an} onChange={() => schalten(i.id)} />
                  <span>
                    <b>{DATENART[i.art] ?? i.art}</b>
                    <span className="sub extern-anlass">{i.anlass}</span>
                  </span>
                </label>
                {i.anker.length > 0 && <div className="extern-idee-anker"><FundChips items={chips(i.anker)} /></div>}
                {an && i.abfragen.map((ab, n) => {
                  if (entfernt.has(`${i.id}:${n}`)) return null
                  const w = werte(i, n)
                  return (
                    <div key={n} className="extern-abfrage">
                      {Object.keys(ab.parameter).map((k) => (
                        <label key={k} className="extern-feld">
                          <span>{FELD[k] ?? k}</span>
                          <input type={feldTyp(k)} value={w[k] ?? ''} onChange={(e) => setzen(i, n, k, e.target.value)} />
                        </label>
                      ))}
                      <div className="extern-abfrage-herkunft">
                        {geaendert(i, n) ? <span className="sub">aus der Eingabe</span> : <FundChips items={chips(ab.anker)} />}
                      </div>
                      <button className="btn ghost" onClick={() => setEntfernt((s) => new Set(s).add(`${i.id}:${n}`))}>Entfernen</button>
                    </div>
                  )
                })}
              </div>
            )
          })}
        </section>

        <section className="extern-eigen">
          <label className="extern-feld extern-text">
            <span>Eigene Anfrage</span>
            <textarea rows={3} maxLength={500} value={text} onChange={(e) => setText(e.target.value)} placeholder="z. B. Wetter in Berlin am 01.03.2024" />
          </label>
          <div>
            <button className="btn primary" disabled={busy || (auswahl.length === 0 && !text.trim())} onClick={abrufen}>
              {busy && <i className="spinner" aria-hidden />}Bericht erstellen
            </button>
          </div>
        </section>

        {(busy || fehler) && (
          <div className="log" role="log" aria-live="polite">
            {busy && <div>{meldung || 'Agent startet …'}</div>}
            {fehler && <div className="err">{fehler}</div>}
          </div>
        )}

        {berichte.map((b, i) => <Fragment key={b.id}><Bericht b={b} offen={i === 0} onEntfernen={() => entfernen(b.id)} /></Fragment>)}
      </div>
    </Page>
  )
}
