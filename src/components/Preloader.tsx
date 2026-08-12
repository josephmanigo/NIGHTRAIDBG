import { useEffect, useRef, useState } from 'react'
import { prefersReducedMotion } from '../lib/motion'

interface PreloaderProps {
  onEnding?: () => void
  onDone?: () => void
}

/** Timing for Akame screen slice completion (ms) before transitioning to hero page. */
const PRELOAD_DURATION_MS = 2900

/** Duration of the smooth exit transition in milliseconds. */
const TRANSITION_DURATION_MS = 1100

/**
 * App-root overlay — deliberately outside the hero's `.nr-hero-surface`
 * (which sets `isolation: isolate`), so it can sit above the fixed header
 * (z-70) without fighting that stacking context. Shows preload.gif;
 * smoothly transitions into the hero with a cinematic scale, blur, and 
 * crimson flare dissolve as the preloader concludes.
 */
export default function Preloader({ onEnding, onDone }: PreloaderProps = {}) {
  const reduced = prefersReducedMotion()
  const [status, setStatus] = useState<'playing' | 'ending' | 'done'>(
    reduced ? 'done' : 'playing'
  )
  const endingTriggeredRef = useRef(false)

  const triggerEnding = () => {
    if (endingTriggeredRef.current) return
    endingTriggeredRef.current = true
    setStatus('ending')
    onEnding?.()
  }

  useEffect(() => {
    if (reduced) {
      onEnding?.()
      onDone?.()
    }
  }, [reduced])

  /* Full playthrough timer for preload animation before transition */
  useEffect(() => {
    if (reduced || status !== 'playing') return
    const timer = window.setTimeout(() => {
      triggerEnding()
    }, PRELOAD_DURATION_MS)

    return () => window.clearTimeout(timer)
  }, [reduced, status])

  /* Transition phase completion timer */
  useEffect(() => {
    if (status === 'ending') {
      const exitTimer = window.setTimeout(() => {
        setStatus('done')
        onDone?.()
      }, TRANSITION_DURATION_MS)

      return () => window.clearTimeout(exitTimer)
    }
  }, [status])

  if (status === 'done') return null

  const isEnding = status === 'ending'

  return (
    <div
      aria-hidden="true"
      className={`fixed inset-0 z-[100] overflow-hidden bg-deep transform-gpu will-change-[opacity,transform,filter] transition-all duration-1100 ease-[cubic-bezier(0.22,1,0.36,1)] ${
        isEnding
          ? 'pointer-events-none opacity-0 scale-[1.03] blur-[8px]'
          : 'opacity-100 scale-100 blur-0'
      }`}
    >
      {!reduced && (
        <img
          src="/preload.gif"
          alt=""
          onError={triggerEnding}
          className={`absolute inset-0 h-full w-full object-cover transform-gpu transition-all duration-1100 ease-[cubic-bezier(0.22,1,0.36,1)] ${
            isEnding ? 'opacity-0 scale-104 brightness-110' : 'opacity-100 scale-100 brightness-100'
          }`}
        />
      )}

      {/* Akame katana slice flare overlay on transition */}
      <div
        className={`absolute inset-0 pointer-events-none transition-opacity duration-900 ease-out ${
          isEnding ? 'opacity-100' : 'opacity-0'
        }`}
      >
        {/* Ambient crimson flash burst */}
        <div className="absolute inset-0 bg-gradient-to-t from-blood/30 via-blood/10 to-blood/30 mix-blend-screen animate-pulse" />

        {/* Diagonal slash beam cut */}
        <div className="absolute top-1/2 left-1/2 w-[160%] h-[3px] -translate-x-1/2 -translate-y-1/2 -rotate-12 bg-gradient-to-r from-transparent via-blood to-transparent shadow-[0_0_40px_#e3262e] animate-nr-sweep" />

        {/* Horizontal slice accent */}
        <div className="absolute top-1/2 left-0 right-0 h-[1px] -translate-y-1/2 bg-gradient-to-r from-transparent via-[#ff4d52] to-transparent shadow-[0_0_20px_#ff4d52]" />
      </div>
    </div>
  )
}

