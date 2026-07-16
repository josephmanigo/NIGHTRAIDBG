import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import { prefersReducedMotion } from '../lib/motion'

export interface CarouselProps {
  /** Total slide count (children length must match). */
  count: number
  index: number
  onIndexChange: (next: number) => void
  label: string
  children: ReactNode
  /** Announced with slide changes, e.g. current caption. */
  announcement?: string
  /** Extra content rendered in the control bar (left side). */
  footerExtra?: ReactNode
  className?: string
}

/**
 * Shared editorial carousel: translated track with pointer drag, touch
 * swipe, keyboard arrows, angular prev/next controls, monospace counter,
 * red progress line and a red sweep line on slide change.
 */
export default function Carousel({
  count,
  index,
  onIndexChange,
  label,
  children,
  announcement,
  footerExtra,
  className = '',
}: CarouselProps) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const [sweepKey, setSweepKey] = useState(0)
  const dragState = useRef<{
    startX: number
    dx: number
    dragging: boolean
    t0: number
    pointerId: number
    suppressClick: boolean
  }>({
    startX: 0,
    dx: 0,
    dragging: false,
    t0: 0,
    pointerId: -1,
    suppressClick: false,
  })
  const reduced = prefersReducedMotion()

  const clamp = useCallback((n: number) => Math.min(Math.max(n, 0), count - 1), [count])

  const goTo = useCallback(
    (next: number) => {
      const target = clamp(next)
      if (target !== index) {
        onIndexChange(target)
        if (!reduced) setSweepKey((k) => k + 1)
      }
    },
    [clamp, index, onIndexChange, reduced],
  )

  /* Track position follows index (transform only). */
  const applyTransform = useCallback(
    (dragPx = 0) => {
      const track = trackRef.current
      const viewport = viewportRef.current
      if (!track || !viewport) return
      const slide = track.children[0] as HTMLElement | undefined
      const slideW = slide ? slide.offsetWidth : viewport.offsetWidth
      const base = -index * slideW
      track.style.transform = `translate3d(${base + dragPx}px,0,0)`
    },
    [index],
  )

  useEffect(() => {
    const track = trackRef.current
    if (!track) return
    track.style.transition = dragState.current.dragging
      ? 'none'
      : reduced
        ? 'transform 0.01s linear'
        : 'transform 0.65s cubic-bezier(0.65, 0.05, 0, 1)'
    applyTransform()
  }, [index, applyTransform, reduced])

  useEffect(() => {
    const onResize = () => applyTransform()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [applyTransform])

  /* Pointer drag / touch swipe */
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const s = dragState.current
    s.dragging = true
    s.startX = e.clientX
    s.dx = 0
    s.t0 = performance.now()
    s.pointerId = e.pointerId
    const track = trackRef.current
    if (track) track.style.transition = 'none'
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const s = dragState.current
    if (!s.dragging) return
    s.dx = e.clientX - s.startX
    // Capture only once it is clearly a horizontal drag, so taps still click
    if (Math.abs(s.dx) > 8) viewportRef.current?.setPointerCapture(s.pointerId)
    // resistance at the ends
    const atStart = index === 0 && s.dx > 0
    const atEnd = index === count - 1 && s.dx < 0
    applyTransform(atStart || atEnd ? s.dx * 0.3 : s.dx)
  }
  const endDrag = () => {
    const s = dragState.current
    if (!s.dragging) return
    s.dragging = false
    s.suppressClick = Math.abs(s.dx) > 10
    const dt = Math.max(performance.now() - s.t0, 1)
    const velocity = Math.abs(s.dx) / dt // px per ms
    const jump = Math.abs(s.dx) > 70 || velocity > 0.45
    const track = trackRef.current
    if (track)
      track.style.transition = reduced
        ? 'transform 0.01s linear'
        : 'transform 0.65s cubic-bezier(0.65, 0.05, 0, 1)'
    if (jump) goTo(index + (s.dx < 0 ? 1 : -1))
    else applyTransform()
    s.dx = 0
  }

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowRight') {
      e.preventDefault()
      goTo(index + 1)
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      goTo(index - 1)
    }
  }

  const counter = (n: number) => String(n + 1).padStart(2, '0')

  return (
    <div className={className}>
      <div
        ref={viewportRef}
        role="group"
        aria-roledescription="carousel"
        aria-label={label}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={endDrag}
        onClickCapture={(e) => {
          // A completed drag must not fire the slide's click action
          if (dragState.current.suppressClick) {
            e.preventDefault()
            e.stopPropagation()
            dragState.current.suppressClick = false
          }
        }}
        className="relative touch-pan-y select-none overflow-hidden outline-offset-4"
      >
        <div ref={trackRef} className="flex will-change-transform">
          {/* Each child is a slide; width is controlled by slideClassName on the child wrapper */}
          {children}
        </div>

        {/* Lime transition line sweeping the frame on slide change */}
        {sweepKey > 0 && (
          <span
            key={sweepKey}
            aria-hidden="true"
            className="animate-nr-sweep pointer-events-none absolute left-0 top-1/2 z-10 h-px w-full bg-blood"
          />
        )}
      </div>

      {/* Live region for assistive tech */}
      <p aria-live="polite" className="sr-only">
        {announcement ?? `Slide ${index + 1} of ${count}`}
      </p>

      {/* Control bar */}
      <div className="mt-5 flex items-center gap-4">
        {footerExtra}
        <div className="ml-auto flex items-center gap-4">
          <span className="ln-label text-ink/50" aria-hidden="true">
            {counter(index)} <span className="text-ink/30">/ {counter(count - 1)}</span>
          </span>
          <div className="relative hidden h-px w-24 bg-ink/15 sm:block" aria-hidden="true">
            <span
              className="absolute inset-y-0 left-0 bg-ink transition-all duration-500 ease-cine"
              style={{ width: `${((index + 1) / count) * 100}%` }}
            />
          </div>
          <button
            type="button"
            className="ln-ctrl"
            onClick={() => goTo(index - 1)}
            disabled={index === 0}
            aria-label={`Previous slide of ${label}`}
          >
            ←
          </button>
          <button
            type="button"
            className="ln-ctrl"
            onClick={() => goTo(index + 1)}
            disabled={index === count - 1}
            aria-label={`Next slide of ${label}`}
          >
            →
          </button>
        </div>
      </div>
    </div>
  )
}

export interface CarouselSlideProps {
  active: boolean
  className?: string
  children: ReactNode
}

/** Slide wrapper: handles the settle-scale on the active image container. */
export function CarouselSlide({ active, className = 'w-full md:w-[72%]', children }: CarouselSlideProps) {
  return (
    <div className={`shrink-0 pr-4 sm:pr-6 ${className}`} data-active={active}>
      <div
        className={`h-full transition-[transform,opacity] duration-700 ease-cine ${
          active ? 'scale-100 opacity-100' : 'scale-[0.965] opacity-55'
        } motion-reduce:scale-100 motion-reduce:opacity-100`}
      >
        {children}
      </div>
    </div>
  )
}
