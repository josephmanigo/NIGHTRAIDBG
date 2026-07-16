import type Lenis from 'lenis'
import { prefersReducedMotion } from './motion'

/* Single Lenis instance shared through the app (set by useSmoothScroll). */
let lenis: Lenis | null = null

export const setLenis = (instance: Lenis | null) => {
  lenis = instance
}

export const getLenis = () => lenis

const NAV_OFFSET = -72

export function scrollToId(id: string) {
  const el = document.getElementById(id)
  if (!el) return
  if (lenis && !prefersReducedMotion()) {
    lenis.scrollTo(el, { offset: NAV_OFFSET, duration: 1.4 })
  } else {
    const top = el.getBoundingClientRect().top + window.scrollY + NAV_OFFSET
    window.scrollTo({ top, behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
  }
}

export function lockScroll() {
  lenis?.stop()
  document.body.style.overflow = 'hidden'
}

export function unlockScroll() {
  lenis?.start()
  document.body.style.overflow = ''
}
