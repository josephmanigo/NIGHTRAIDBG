import { useEffect, useState } from 'react'
import { prefersReducedMotion } from '../lib/motion'

/** Safety net in case autoplay is blocked and the video's 'ended' event never fires. */
const FALLBACK_MS = 4000

/**
 * App-root overlay — deliberately outside the hero's `.nr-hero-surface`
 * (which sets `isolation: isolate`), so it can sit above the fixed header
 * (z-70) without fighting that stacking context. Plays preload.mp4 once;
 * the video naturally holds on its final frame (the slash/impact beat)
 * once 'ended' fires, then fades straight into the hero from there.
 */
export default function Preloader() {
  const reduced = prefersReducedMotion()
  const [done, setDone] = useState(reduced)

  useEffect(() => {
    if (reduced || done) return
    const t = window.setTimeout(() => setDone(true), FALLBACK_MS)
    return () => window.clearTimeout(t)
  }, [reduced, done])

  return (
    <div
      aria-hidden="true"
      className={`fixed inset-0 z-[100] bg-deep transition-opacity duration-700 ${
        done ? 'pointer-events-none opacity-0' : 'opacity-100'
      }`}
    >
      {!reduced && (
        <video
          autoPlay
          muted
          playsInline
          preload="auto"
          src="/preload.mp4"
          onEnded={() => setDone(true)}
          onError={() => setDone(true)}
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}
    </div>
  )
}
