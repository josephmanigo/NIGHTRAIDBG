import { useEffect, useRef } from 'react'
import { gsap, prefersReducedMotion } from '../lib/motion'

interface RevealOptions {
  /** Reveal children matching this selector instead of the element itself */
  selector?: string
  stagger?: number
  y?: number
  start?: string
}

/** Fade-up reveal when the element enters the viewport (runs once). */
export function useReveal<T extends HTMLElement>(options: RevealOptions = {}) {
  const ref = useRef<T>(null)
  const { selector, stagger = 0.08, y = 36, start = 'top 84%' } = options

  useEffect(() => {
    const el = ref.current
    if (!el || prefersReducedMotion()) return

    const targets = selector ? Array.from(el.querySelectorAll(selector)) : [el]
    if (targets.length === 0) return

    const ctx = gsap.context(() => {
      gsap.from(targets, {
        y,
        autoAlpha: 0,
        duration: 0.9,
        ease: 'power3.out',
        stagger,
        scrollTrigger: { trigger: el, start, once: true },
      })
    }, el)
    return () => ctx.revert()
  }, [selector, stagger, y, start])

  return ref
}

/** Counts a number up from 0 when scrolled into view. */
export function useCountUp<T extends HTMLElement>(value: number, suffix = '') {
  const ref = useRef<T>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (prefersReducedMotion()) {
      el.textContent = `${value}${suffix}`
      return
    }
    el.textContent = `0${suffix}`
    const counter = { n: 0 }
    const ctx = gsap.context(() => {
      gsap.to(counter, {
        n: value,
        duration: 1.8,
        ease: 'power2.out',
        scrollTrigger: { trigger: el, start: 'top 88%', once: true },
        onUpdate: () => {
          el.textContent = `${Math.round(counter.n)}${suffix}`
        },
      })
    }, el)
    return () => ctx.revert()
  }, [value, suffix])

  return ref
}
