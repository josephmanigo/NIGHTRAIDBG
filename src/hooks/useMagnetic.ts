import { useEffect } from 'react'
import { gsap, isFinePointer, prefersReducedMotion } from '../lib/motion'

/** Restrained magnetic pull on [data-magnetic] elements (max ~6px),
 *  fine pointers only. Re-runs when `deps` change so late-mounted
 *  elements get wired up. */
export function useMagnetic(deps: unknown[] = []) {
  useEffect(() => {
    if (!isFinePointer() || prefersReducedMotion()) return
    const els = Array.from(document.querySelectorAll<HTMLElement>('[data-magnetic]'))
    const cleanups = els.map((el) => {
      const xTo = gsap.quickTo(el, 'x', { duration: 0.4, ease: 'power3.out' })
      const yTo = gsap.quickTo(el, 'y', { duration: 0.4, ease: 'power3.out' })
      const move = (e: MouseEvent) => {
        const r = el.getBoundingClientRect()
        xTo(((e.clientX - r.left) / r.width - 0.5) * 12)
        yTo(((e.clientY - r.top) / r.height - 0.5) * 10)
      }
      const leave = () => {
        xTo(0)
        yTo(0)
      }
      el.addEventListener('mousemove', move)
      el.addEventListener('mouseleave', leave)
      return () => {
        el.removeEventListener('mousemove', move)
        el.removeEventListener('mouseleave', leave)
        gsap.set(el, { x: 0, y: 0 })
      }
    })
    return () => cleanups.forEach((fn) => fn())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}
