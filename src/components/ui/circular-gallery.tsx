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
  /** Starting rotation angle in degrees — useful with a single item to give
   *  a static card a slight 3D tilt instead of facing the camera flat-on. */
  initialRotation?: number
}

const CircularGallery = React.forwardRef<HTMLDivElement, CircularGalleryProps>(
  (
    {
      items,
      className,
      radius = 600,
      autoRotateSpeed = 0.02,
      interactive = true,
      initialRotation = 0,
      ...props
    },
    ref,
  ) => {
    const [rotation, setRotation] = useState(initialRotation)
    const [isDragging, setIsDragging] = useState(false)
    const [containerWidth, setContainerWidth] = useState(0)
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

    // Free rotation loop; after a drag the release velocity eases back into it.
    useEffect(() => {
      if (!interactive) return
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
    }, [isDragging, autoRotateSpeed, reduced, interactive])

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
    const itemWidth = compact ? 220 : 300
    const itemHeight = compact ? 320 : 400
    const effectiveRadius = containerWidth
      ? Math.min(radius, Math.max(240, containerWidth * 0.36))
      : radius

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
        style={{ perspective: '2000px', touchAction: 'pan-y' }}
        {...props}
      >
        <div
          className="relative h-full w-full"
          style={{
            transform: `rotateY(${rotation}deg)`,
            transformStyle: 'preserve-3d',
          }}
        >
          {items.map((item, i) => {
            const itemAngle = i * anglePerItem
            const totalRotation = rotation % 360
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
                  transform: `rotateY(${itemAngle}deg) translateZ(${effectiveRadius}px)`,
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

export { CircularGallery }
