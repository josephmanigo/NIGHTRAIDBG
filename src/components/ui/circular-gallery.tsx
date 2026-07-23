import React, { useState, useEffect, useRef, HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'
import { prefersReducedMotion } from '@/lib/motion'

// Define the type for a single gallery item
export interface GalleryItem {
  common: string
  binomial: string
  photo: {
    url: string
    text: string
    pos?: string
    by: string
  }
}

/** Perspective (px) set on the gallery's outer container — the front card's
 *  translateZ(radius) magnifies it by perspective/(perspective-radius), so
 *  this constant is needed both to render and to correct for that magnification. */
const PERSPECTIVE = 2000
/** Radius the "All" view uses — the visual baseline every other radius
 *  (fewer items, tighter chord spacing) corrects its card size against. */
const REFERENCE_RADIUS = 350

// Define the props for the CircularGallery component
interface CircularGalleryProps extends HTMLAttributes<HTMLDivElement> {
  items: GalleryItem[]
  /** Controls how far the items are from the center. */
  radius?: number
  /** Controls the speed of the free rotation. */
  autoRotateSpeed?: number
  /** When false, disables auto-rotation, dragging and keyboard rotation —
   *  the card(s) still render with the same 3D perspective, just frozen. */
  interactive?: boolean
}

const CircularGallery = React.forwardRef<HTMLDivElement, CircularGalleryProps>(
  ({ items, className, radius = 600, autoRotateSpeed = 0.02, interactive = true, ...props }, ref) => {
    const [rotation, setRotation] = useState(0)
    const [isDragging, setIsDragging] = useState(false)
    const [containerWidth, setContainerWidth] = useState(0)
    const [inView, setInView] = useState(true)
    const containerRef = useRef<HTMLDivElement | null>(null)
    const animationFrameRef = useRef<number | null>(null)
    const dragRef = useRef({ lastX: 0, velocity: 0 })
    const reduced = prefersReducedMotion()

    useEffect(() => {
      const container = containerRef.current
      if (!container) return

      const measure = () => setContainerWidth(container.offsetWidth)
      measure()
      const observer = new ResizeObserver(measure)
      observer.observe(container)
      return () => observer.disconnect()
    }, [])

    /* The auto-rotation re-renders every frame; skip the whole loop while
     * the gallery is scrolled out of view. */
    useEffect(() => {
      const container = containerRef.current
      if (!container || typeof IntersectionObserver === 'undefined') return
      const observer = new IntersectionObserver(
        (entries) => setInView(Boolean(entries[0]?.isIntersecting)),
        { rootMargin: '15% 0px' },
      )
      observer.observe(container)
      return () => observer.disconnect()
    }, [])

    // Free rotation loop; after a drag the release velocity eases back into it.
    useEffect(() => {
      if (!interactive || !inView) return
      const tick = () => {
        if (!isDragging) {
          dragRef.current.velocity *= 0.95
          const v = dragRef.current.velocity
          if (!reduced || Math.abs(v) > 0.001) {
            setRotation((prev) => prev + (reduced ? 0 : autoRotateSpeed) + v)
          }
        }
        animationFrameRef.current = requestAnimationFrame(tick)
      }

      animationFrameRef.current = requestAnimationFrame(tick)

      return () => {
        if (animationFrameRef.current) {
          cancelAnimationFrame(animationFrameRef.current)
        }
      }
    }, [isDragging, autoRotateSpeed, reduced, interactive, inView])

    const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
      if (!interactive) return
      setIsDragging(true)
      dragRef.current.lastX = e.clientX
      dragRef.current.velocity = 0
      e.currentTarget.setPointerCapture(e.pointerId)
    }

    const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
      if (!interactive || !isDragging) return
      const dx = e.clientX - dragRef.current.lastX
      dragRef.current.lastX = e.clientX
      const delta = dx * 0.25
      dragRef.current.velocity = delta
      setRotation((prev) => prev + delta)
    }

    const endDrag = () => setIsDragging(false)

    const anglePerItem = 360 / items.length
    const compact = containerWidth > 0 && containerWidth < 640
    const itemWidth = compact ? 240 : 330
    const itemHeight = compact ? 350 : 440
    const clampRadius = (r: number) =>
      containerWidth ? Math.min(r, Math.max(240, containerWidth * 0.36)) : r
    const effectiveRadius = clampRadius(radius)
    /* translateZ(radius) magnifies the front card by perspective/(perspective-radius) —
     * different radii (e.g. a smaller chord-length radius for fewer items) would
     * otherwise render visibly smaller/larger than the "All" view's fixed radius.
     * This scales every card back to the size REFERENCE_RADIUS would have produced. */
    const effectiveReference = clampRadius(REFERENCE_RADIUS)
    const sizeCorrection = (PERSPECTIVE - effectiveRadius) / (PERSPECTIVE - effectiveReference)
    // Non-interactive views (e.g. the single-team card) must render dead-center —
    // derived synchronously so there's no stale-rotation frame left over from a
    // previous interactive/auto-rotating view while an effect catches up.
    const displayRotation = interactive ? rotation : 0

    return (
      <div
        ref={(node) => {
          containerRef.current = node
          if (typeof ref === 'function') ref(node)
          else if (ref) ref.current = node
        }}
        role="region"
        aria-label={interactive ? 'Circular 3D gallery — drag to rotate' : 'Team card'}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={(event) => {
          if (!interactive) return
          if (event.key === 'ArrowRight') {
            event.preventDefault()
            setRotation((current) => current - anglePerItem)
          }
          if (event.key === 'ArrowLeft') {
            event.preventDefault()
            setRotation((current) => current + anglePerItem)
          }
        }}
        tabIndex={interactive ? 0 : -1}
        className={cn(
          'relative flex h-full w-full select-none items-center justify-center',
          interactive ? (isDragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-default',
          className,
        )}
        style={{ perspective: `${PERSPECTIVE}px`, touchAction: 'pan-y' }}
        {...props}
      >
        <div
          className="relative h-full w-full"
          style={{
            transform: `rotateY(${displayRotation}deg)`,
            transformStyle: 'preserve-3d',
          }}
        >
          {items.map((item, i) => {
            const itemAngle = i * anglePerItem
            const totalRotation = displayRotation % 360
            const relativeAngle = (itemAngle + totalRotation + 360) % 360
            const normalizedAngle = Math.abs(relativeAngle > 180 ? 360 - relativeAngle : relativeAngle)
            const opacity = Math.max(0.68, 1 - normalizedAngle / 180)

            return (
              <div
                key={item.photo.url}
                role="group"
                aria-label={item.common}
                className="absolute"
                style={{
                  width: itemWidth,
                  height: itemHeight,
                  transform: `rotateY(${itemAngle}deg) translateZ(${effectiveRadius}px) scale(${sizeCorrection})`,
                  left: '50%',
                  top: '50%',
                  marginLeft: -itemWidth / 2,
                  marginTop: -itemHeight / 2,
                  opacity: opacity,
                  transition: 'opacity 0.3s linear',
                }}
              >
                <div className="group relative h-full w-full overflow-hidden rounded-2xl border border-line bg-paper-deep/60 backdrop-blur-lg">
                  <img
                    src={item.photo.url}
                    alt={item.photo.text}
                    draggable={false}
                    loading="lazy"
                    decoding="async"
                    className="absolute inset-0 h-full w-full object-cover"
                    style={{ objectPosition: item.photo.pos || 'center' }}
                  />
                </div>
              </div>
            )
          })}
        </div>
      </div>
    )
  },
)

CircularGallery.displayName = 'CircularGallery'

export { CircularGallery, REFERENCE_RADIUS }
