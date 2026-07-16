import { useEffect, useRef } from 'react'
import { useFocusTrap } from '../hooks/useFocusTrap'

export interface LightboxImage {
  src: string
  alt: string
  caption?: string
  meta?: string
}

interface LightboxProps {
  images: LightboxImage[]
  index: number
  onClose: () => void
  onNavigate: (next: number) => void
  label: string
}

/** Accessible fullscreen gallery: focus trapped, Escape closes, arrows
 *  navigate, focus returns to the opener on close (via useFocusTrap). */
export default function Lightbox({ images, index, onClose, onNavigate, label }: LightboxProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef, true, onClose)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') onNavigate(Math.min(index + 1, images.length - 1))
      if (e.key === 'ArrowLeft') onNavigate(Math.max(index - 1, 0))
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [index, images.length, onNavigate])

  const img = images[index]
  if (!img) return null

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-label={`${label} — fullscreen gallery`}
      className="fixed inset-0 z-80 flex flex-col bg-ink/[0.97] backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="flex items-center justify-between px-5 py-4 sm:px-8">
        <span className="ln-label text-bone/60">
          {String(index + 1).padStart(2, '0')} / {String(images.length).padStart(2, '0')}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="flex h-11 w-11 items-center justify-center rounded-full bg-paper text-lg text-ink transition-colors hover:bg-blood hover:text-bone"
          aria-label="Close gallery"
        >
          ✕
        </button>
      </div>

      <div className="relative flex min-h-0 flex-1 items-center justify-center px-4 pb-4 sm:px-16">
        <img
          key={img.src}
          src={img.src}
          alt={img.alt}
          className="max-h-full max-w-full rounded-xl object-contain"
        />
        <button
          type="button"
          className="ln-ctrl-dark absolute left-3 top-1/2 -translate-y-1/2 sm:left-6"
          onClick={() => onNavigate(Math.max(index - 1, 0))}
          disabled={index === 0}
          aria-label="Previous image"
        >
          ←
        </button>
        <button
          type="button"
          className="ln-ctrl-dark absolute right-3 top-1/2 -translate-y-1/2 sm:right-6"
          onClick={() => onNavigate(Math.min(index + 1, images.length - 1))}
          disabled={index === images.length - 1}
          aria-label="Next image"
        >
          →
        </button>
      </div>

      {(img.caption || img.meta) && (
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-t border-haze px-5 py-4 sm:px-8">
          <p className="text-sm text-bone">{img.caption}</p>
          {img.meta && <p className="ln-label text-blood">{img.meta}</p>}
        </div>
      )}
    </div>
  )
}
