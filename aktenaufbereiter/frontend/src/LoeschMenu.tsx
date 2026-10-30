import { useLayoutEffect, useRef, useState } from 'react'
import type { Massenverfahren } from './api'

export type LoeschZiel = { art: 'akte' | 'mv'; id: string; name: string; text: string }
export type MenuStand = { ziel: LoeschZiel; x: number; y: number; ausloeser: HTMLElement }

export const aktenZiel = (id: string, name: string): LoeschZiel => ({
  art: 'akte', id, name,
  text: `„${name}“ wird endgültig gelöscht, mit allen Aufbereitungen und Anmerkungen. Das lässt sich nicht rückgängig machen.`,
})
export const mvZiel = (m: Massenverfahren): LoeschZiel => ({
  art: 'mv', id: m.id, name: m.sache,
  text: `„${m.sache}“ wird mit ${m.mitglieder.length} Akten${m.sammelakte_id ? ' und der Sammelakte' : ''} endgültig gelöscht, mit allen Aufbereitungen und Anmerkungen. Das lässt sich nicht rückgängig machen.`,
})

export function LoeschMenu({ stand, deaktiviert, onClose, onWaehlen }: {
  stand: MenuStand; deaktiviert: boolean; onClose: () => void; onWaehlen: () => void
}) {
  const menu = useRef<HTMLDivElement>(null)
  const eintrag = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => {
    const el = menu.current!
    el.style.left = `${Math.max(0, Math.min(stand.x, window.innerWidth - el.offsetWidth))}px`
    el.style.top = `${Math.max(0, Math.min(stand.y, window.innerHeight - el.offsetHeight))}px`
    if (eintrag.current?.disabled) el.focus()
    else eintrag.current?.focus()
    const ausserhalb = (e: PointerEvent) => { if (!el.contains(e.target as Node)) onClose() }
    const taste = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); onClose() }
    }
    document.addEventListener('pointerdown', ausserhalb)
    document.addEventListener('keydown', taste)
    window.addEventListener('scroll', onClose, true)
    window.addEventListener('resize', onClose)
    return () => {
      document.removeEventListener('pointerdown', ausserhalb)
      document.removeEventListener('keydown', taste)
      window.removeEventListener('scroll', onClose, true)
      window.removeEventListener('resize', onClose)
      stand.ausloeser.focus({ preventScroll: true })
    }
  }, [stand, onClose])
  return <div ref={menu} role="menu" aria-label="Löschen" tabIndex={-1} className="loesch-menu">
    <button ref={eintrag} role="menuitem" disabled={deaktiviert} title={deaktiviert ? 'Agent arbeitet' : undefined} onClick={onWaehlen}>Löschen …</button>
  </div>
}

export function LoeschDialog({ ziel, ausloeser, onClose, onLoeschen }: {
  ziel: LoeschZiel; ausloeser: HTMLElement; onClose: () => void; onLoeschen: () => Promise<void>
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const abbrechen = useRef<HTMLButtonElement>(null)
  const anfrage = useRef(false)
  const [busy, setBusy] = useState(false)
  const [fehler, setFehler] = useState('')
  useLayoutEffect(() => {
    const el = dialog.current!
    el.showModal()
    abbrechen.current?.focus()
    return () => { el.close(); ausloeser.focus({ preventScroll: true }) }
  }, [ausloeser])
  const loeschen = async () => {
    if (anfrage.current) return
    anfrage.current = true
    setBusy(true); setFehler('')
    try { await onLoeschen() }
    catch (err) { setFehler(err instanceof Error ? err.message : String(err)) }
    finally { anfrage.current = false; setBusy(false) }
  }
  return <dialog ref={dialog} className="loesch-dialog" aria-labelledby="loesch-titel" aria-describedby="loesch-text"
    onCancel={(e) => { e.preventDefault(); onClose() }}>
    <h2 id="loesch-titel">{ziel.art === 'akte' ? 'Akte löschen?' : 'Massenverfahren löschen?'}</h2>
    <p id="loesch-text">{ziel.text}</p>
    {fehler && <p role="alert">{fehler}</p>}
    <div className="loesch-aktionen">
      <button ref={abbrechen} autoFocus className="btn" disabled={busy} onClick={onClose}>Abbrechen</button>
      <button className="btn danger" disabled={busy} onClick={loeschen}>Endgültig löschen</button>
    </div>
  </dialog>
}
