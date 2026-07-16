import { useEffect, useState } from 'react'
import { prefersReducedMotion } from '../lib/motion'

/** One playthrough of preload.gif: 37 frames @ 80ms = 2960ms. */
const GIF_DURATION_MS = 2960

/**
 * App-root overlay — deliberately outside the hero's `.nr-hero-surface`
 * (which sets `isolation: isolate`), so it can sit above the fixed header
 * (z-70) without fighting that stacking context. Dismisses itself after one
 * loop of the gif; never waits on the hero background video.
 */
export default function Preloader() {
  const [booted, setBooted] = useState(() => prefersReducedMotion())

  useEffect(() => {
    if (prefersReducedMotion()) return
    const t = window.setTimeout(() => setBooted(true), GIF_DURATION_MS)
    return () => window.clearTimeout(t)
  }, [])

  return (
    <div
      aria-hidden="true"
      className={`fixed inset-0 z-[100] bg-deep transition-opacity duration-700 ${
        booted ? 'pointer-events-none opacity-0' : 'opacity-100'
      }`}
    >
      <img src="/preload.gif" alt="" className="absolute inset-0 h-full w-full object-cover" />
    </div>
  )
}
