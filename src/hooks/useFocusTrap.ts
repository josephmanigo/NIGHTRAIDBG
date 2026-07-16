import { useEffect, type RefObject } from 'react'
import { lockScroll, unlockScroll } from '../lib/scroll'

const FOCUSABLE =
  'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])'

/** Focus trap for dialogs/lightboxes: locks scroll, traps Tab, closes on
 *  Escape, restores focus to the opener on cleanup. */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  onClose: () => void,
) {
  useEffect(() => {
    if (!active) return
    const panel = ref.current
    if (!panel) return
    const opener = document.activeElement as HTMLElement | null
    lockScroll()

    const focusables = () =>
      Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null,
      )
    ;(focusables()[0] ?? panel).focus()

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      } else if (e.key === 'Tab') {
        const items = focusables()
        if (items.length === 0) return
        const first = items[0]
        const last = items[items.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey, true)

    return () => {
      document.removeEventListener('keydown', onKey, true)
      unlockScroll()
      opener?.focus()
    }
  }, [ref, active, onClose])
}
