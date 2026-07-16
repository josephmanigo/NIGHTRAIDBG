import { useEffect, useState } from 'react'
import { prefersReducedMotion } from '../lib/motion'

/** preload.gif's final frame (the slash/impact beat) starts at 2880ms — the
 *  gif never gets a chance to loop back to its calm opening frame. */
const SLICE_AT_MS = 2880

/**
 * App-root overlay — deliberately outside the hero's `.nr-hero-surface`
 * (which sets `isolation: isolate`), so it can sit above the fixed header
 * (z-70) without fighting that stacking context. At the slice beat, swaps
 * the animated gif for a static freeze-frame of that exact moment (so the
 * hold is pixel-perfect regardless of any timer/decode drift) and starts
 * fading straight into the hero — it never waits on the hero video.
 */
export default function Preloader() {
  const [sliced, setSliced] = useState(() => prefersReducedMotion())

  useEffect(() => {
    if (prefersReducedMotion()) return
    const t = window.setTimeout(() => setSliced(true), SLICE_AT_MS)
    return () => window.clearTimeout(t)
  }, [])

  return (
    <div
      aria-hidden="true"
      className={`fixed inset-0 z-[100] bg-deep transition-opacity duration-700 ${
        sliced ? 'pointer-events-none opacity-0' : 'opacity-100'
      }`}
    >
      <img
        src={sliced ? '/preload-slice.png' : '/preload.gif'}
        alt=""
        className="absolute inset-0 h-full w-full object-cover"
      />
    </div>
  )
}
