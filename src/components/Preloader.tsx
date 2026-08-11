import { useEffect, useRef, useState } from 'react'
import { prefersReducedMotion } from '../lib/motion'

/** Safety net in case autoplay is blocked and video's timeupdate/ended never fire. */
const FALLBACK_MS = 6000

/** Duration of the smooth exit ender transition in milliseconds. */
const TRANSITION_DURATION_MS = 1000

/**
 * App-root overlay — deliberately outside the hero's `.nr-hero-surface`
 * (which sets `isolation: isolate`), so it can sit above the fixed header
 * (z-70) without fighting that stacking context. Plays preload.mp4 once;
 * smoothly transitions into the hero with a cinematic scale, blur, and 
 * crimson flare dissolve as the preloader concludes.
 */
export default function Preloader() {
  const reduced = prefersReducedMotion()
  const [status, setStatus] = useState<'playing' | 'ending' | 'done'>(
    reduced ? 'done' : 'playing'
  )
  const endingTriggeredRef = useRef(false)
  const videoRef = useRef<HTMLVideoElement>(null)

  const triggerEnding = () => {
    if (endingTriggeredRef.current) return
    endingTriggeredRef.current = true
    setStatus('ending')
  }

  /* Safety fallback timeout */
  useEffect(() => {
    if (reduced || status !== 'playing') return
    const fallbackTimer = window.setTimeout(() => {
      triggerEnding()
    }, FALLBACK_MS)

    return () => window.clearTimeout(fallbackTimer)
  }, [reduced, status])

  /* Transition phase completion timer */
  useEffect(() => {
    if (status === 'ending') {
      const exitTimer = window.setTimeout(() => {
        setStatus('done')
      }, TRANSITION_DURATION_MS)

      return () => window.clearTimeout(exitTimer)
    }
  }, [status])

  const handleTimeUpdate = () => {
    const video = videoRef.current
    if (!video || status !== 'playing') return
    // Trigger smooth transition slightly before full video end to prevent frame freeze
    if (video.duration && video.currentTime >= video.duration - 0.35) {
      triggerEnding()
    }
  }

  if (status === 'done') return null

  const isEnding = status === 'ending'

  return (
    <div
      aria-hidden="true"
      className={`fixed inset-0 z-[100] overflow-hidden bg-deep transform-gpu will-change-[opacity,transform,filter] transition-all duration-1000 ease-[cubic-bezier(0.16,1,0.3,1)] ${
        isEnding
          ? 'pointer-events-none opacity-0 scale-[1.04] blur-[4px]'
          : 'opacity-100 scale-100 blur-0'
      }`}
    >
      {!reduced && (
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          preload="auto"
          onTimeUpdate={handleTimeUpdate}
          onEnded={triggerEnding}
          onError={triggerEnding}
          className={`absolute inset-0 h-full w-full object-cover transform-gpu transition-all duration-1000 ease-out ${
            isEnding ? 'scale-105 brightness-110' : 'scale-100 brightness-100'
          }`}
        >
          <source src="/preload.mp4" type="video/mp4" />
          <source src="/preload.mov" type="video/quicktime" />
        </video>
      )}

      {/* Crimson flare sweep line on exit */}
      <div
        className={`absolute inset-0 pointer-events-none transition-opacity duration-700 ease-out ${
          isEnding ? 'opacity-100' : 'opacity-0'
        }`}
      >
        <div className="absolute inset-0 bg-gradient-to-t from-blood/20 via-transparent to-blood/20 mix-blend-screen" />
        <div className="absolute top-1/2 left-0 right-0 h-[2px] -translate-y-1/2 bg-gradient-to-r from-transparent via-blood to-transparent shadow-[0_0_20px_#e3262e] animate-nr-sweep" />
      </div>
    </div>
  )
}

