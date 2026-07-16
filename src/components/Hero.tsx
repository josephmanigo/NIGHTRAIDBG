import { useEffect, useRef, useState } from 'react'
import { gsap, ScrollTrigger, prefersReducedMotion, isFinePointer } from '../lib/motion'

const VIDEO_SRC = '/hero-bg-pingpong.mp4'
const POSTER_SRC = '/hero.webp'

/**
 * Paddock-editorial hero: cream paper with topographic contours, a giant
 * two-line headline sliding behind a centered media frame.
 *
 * hero-bg-pingpong.mp4 has the reverse pass baked in (forward + reversed
 * concatenated, turnaround frame deduplicated), so the native `loop`
 * attribute produces a seamless back-and-forth with zero JS seeking —
 * backward currentTime scrubbing is slow and janky on real mobile
 * browsers, so it must never be reintroduced here.
 */
export default function Hero() {
  const rootRef = useRef<HTMLElement>(null)
  const pinRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [videoReady, setVideoReady] = useState(false)
  const [booted, setBooted] = useState(false) // loader dismissed
  const [initScrollTrigger, setInitScrollTrigger] = useState(false)
  const reduced = prefersReducedMotion()
  /* Touch devices skip the scroll-linked grayscale: animating a CSS filter
   * over a playing 1080p video is expensive on phones, and iOS Safari has a
   * WebKit bug where a filter on a <video>'s ancestor breaks object-fit,
   * rendering the video letterboxed instead of cover-cropped. */
  const [finePointer] = useState(() => isFinePointer())

  useEffect(() => {
    if (reduced) setBooted(true)
  }, [reduced])

  /* Dismiss the loading state after one playthrough of preload.gif (37 frames
   * @ 80ms = ~2.96s) — the hero video keeps loading behind it and crossfades
   * in over the poster whenever it becomes ready, so the veil never waits on it. */
  useEffect(() => {
    if (reduced) return
    const t = window.setTimeout(() => setBooted(true), 2960)
    return () => window.clearTimeout(t)
  }, [reduced])

  /* Entrance timeline — runs once, when the loader clears. */
  useEffect(() => {
    if (!booted || reduced) return
    const scope = pinRef.current
    if (!scope) return
    const ctx = gsap.context(() => {
      const tl = gsap.timeline({ defaults: { ease: 'power3.out' } })
      tl.fromTo(
        '[data-hero-frame]',
        { scale: 1.02 },
        {
          scale: 1,
          duration: 1.4,
          ease: 'power4.inOut',
          onComplete: () => {
            setInitScrollTrigger(true)
          },
        },
      )
        .from('[data-hero-line="1"] > span', { yPercent: 112, duration: 0.9, ease: 'power4.out' }, '-=0.7')
        .from('[data-hero-line="2"] > span', { yPercent: 112, duration: 0.9, ease: 'power4.out' }, '-=0.72')
    }, scope)
    return () => ctx.revert()
  }, [booted, reduced])

  /* Scroll Listener to immediately enable scroll trigger if scroll happens before entrance completes. */
  useEffect(() => {
    if (booted) {
      const handleScroll = () => {
        if (window.scrollY > 5) {
          setInitScrollTrigger(true)
          window.removeEventListener('scroll', handleScroll)
        }
      }
      window.addEventListener('scroll', handleScroll, { passive: true })
      return () => window.removeEventListener('scroll', handleScroll)
    }
  }, [booted])

  /* Scroll: the full-bleed film resolves into an editorial portrait card. */
  useEffect(() => {
    if (reduced || !initScrollTrigger) return
    const scope = rootRef.current
    if (!scope) return
    const ctx = gsap.context(() => {
      // Pin the frame container
      ScrollTrigger.create({
        trigger: scope,
        start: 'top top',
        end: 'bottom bottom',
        pin: '[data-hero-pin]',
        pinSpacing: false,
      })

      const scrub = {
        trigger: scope,
        start: 'top top',
        end: 'bottom bottom',
        scrub: true,
        invalidateOnRefresh: true,
      }
      const textScrub = {
        ...scrub,
        scrub: 1.15,
      }
      const frameScrub = {
        ...scrub,
        scrub: 0.65,
      }

      gsap.fromTo(
        '[data-hero-line="1"]',
        { xPercent: -8, y: () => -window.innerHeight * 0.155 },
        { xPercent: -2, y: () => -window.innerHeight * 0.14, ease: 'none', force3D: true, scrollTrigger: textScrub },
      )
      gsap.fromTo(
        '[data-hero-line="2"]',
        { xPercent: 8, y: () => window.innerHeight * 0.165 },
        { xPercent: 2, y: () => window.innerHeight * 0.185, ease: 'none', force3D: true, scrollTrigger: textScrub },
      )

      // Scale on the compositor so the centered film never jitters from layout reflow.
      gsap.fromTo(
        '[data-hero-frame]',
        {
          scale: 1,
          borderRadius: '0px',
          transformOrigin: '50% 50%',
          force3D: true,
        },
        {
          scale: () =>
            window.innerWidth < 640
              ? 0.78
              : gsap.utils.clamp(
                  0.34,
                  0.46,
                  Math.max(640 / window.innerWidth, 380 / window.innerHeight),
                ),
          borderRadius: () => (window.innerWidth < 640 ? '14px' : '8px'),
          ease: 'none',
          force3D: true,
          scrollTrigger: frameScrub,
        },
      )
      if (finePointer) {
        gsap.fromTo(
          '[data-hero-media]',
          { filter: 'grayscale(0) contrast(1) brightness(1)' },
          { filter: 'grayscale(1) contrast(1.05) brightness(1)', ease: 'none', scrollTrigger: frameScrub },
        )
      }
      gsap.fromTo(
        '[data-hero-signature]',
        { autoAlpha: 0, scale: 0.76, rotate: -13 },
        { autoAlpha: 1, scale: 1, rotate: -8, ease: 'none', scrollTrigger: scrub },
      )
      gsap.fromTo(
        '[data-hero-kicker]',
        { autoAlpha: 0, y: -24 },
        { autoAlpha: 1, y: 0, ease: 'none', scrollTrigger: scrub },
      )
    }, scope)
    return () => {
      ctx.revert()
    }
  }, [reduced, initScrollTrigger, finePointer])

  /* Crossfade the poster out once frames are actually rendering. */
  useEffect(() => {
    if (reduced) return
    const video = videoRef.current
    if (!video) return

    let cancelled = false
    const markPlaying = () => {
      if (!cancelled) setVideoReady(true)
    }
    video.addEventListener('playing', markPlaying)
    if (!video.paused) markPlaying()

    return () => {
      cancelled = true
      video.removeEventListener('playing', markPlaying)
    }
  }, [reduced])

  const showVideo = !reduced

  return (
    <section id="home" ref={rootRef} className="relative h-[220vh]" aria-label="NIGHTRAID — raid the night, rule the game">
      <div
        ref={pinRef}
        data-hero-pin
        className="nr-hero-surface relative h-[100svh] w-full touch-pan-y overflow-hidden"
      >
        <h1 className="sr-only">NIGHTRAID — Raid the night, rule the game.</h1>

        {/* ---- Small editorial marker revealed in the composed scroll state ---- */}
        <div
          data-hero-kicker
          aria-hidden="true"
          /* Mobile: the card only shrinks to 0.78, putting its top edge at
           * ~11svh — the mark must sit in the strip above it or it straddles
           * the card edge and looks cut. Desktop cards are far smaller, so
           * sm+ keeps the roomier 9vh drop. */
          className="pointer-events-none absolute left-1/2 top-[3svh] z-30 -translate-x-1/2 text-center opacity-0 sm:top-[9vh]"
        >
          <span className="mx-auto block font-display text-3xl italic leading-none tracking-[-0.1em] text-blood sm:text-4xl">
            NR
          </span>
        </div>

        {/* ---- Giant headline sliding behind the media ---- */}
        <div
          data-hero-copy
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-[5] flex select-none flex-col items-center justify-center"
        >
          <div
            data-hero-line="1"
            className="block overflow-visible whitespace-nowrap font-serif text-[clamp(2.9rem,17vw,18rem)] font-normal uppercase leading-[0.84] tracking-[-0.055em] text-blood will-change-transform"
          >
            <span className="block">Raid the night,</span>
          </div>
          <div
            data-hero-line="2"
            className="block overflow-visible whitespace-nowrap font-display text-[clamp(2.6rem,14.5vw,16rem)] uppercase leading-[0.8] tracking-[-0.035em] text-bone will-change-transform"
          >
            <span className="block">Rule the game.</span>
          </div>
        </div>

        {/* ---- Media frame ---- */}
        <div
          ref={frameRef}
          data-hero-frame
          data-theme="dark"
          className="absolute inset-0 z-10 overflow-hidden bg-deep will-change-transform rounded-none"
        >
          <div data-hero-media className={`absolute inset-0 ${finePointer ? 'will-change-[filter]' : ''}`}>
          {/* Poster: loading state, reduced-motion state and video fallback */}
          <img
            src={POSTER_SRC}
            alt=""
            aria-hidden="true"
            className={`absolute inset-0 h-full w-full object-cover object-[68%_center] transition-opacity duration-700 ${
              showVideo && videoReady ? 'opacity-0' : 'opacity-100'
            }`}
          />
          {showVideo && (
            <video
              ref={videoRef}
              autoPlay
              muted
              playsInline
              loop
              preload="auto"
              poster={POSTER_SRC}
              src={VIDEO_SRC}
              aria-hidden="true"
              tabIndex={-1}
              /* Cover-crop via explicit geometry instead of object-fit: the
               * media box always spans the viewport (transform scale on the
               * frame doesn't change layout), so max(100vw, 16/9 of 100svh)
               * + aspect-ratio covers both axes, the frame's overflow-hidden
               * crops the spill, and the translate reproduces the 68%-center
               * focal point. iOS Safari letterboxes object-fit'd videos when
               * filters are in play, so don't reintroduce object-cover here. */
              className={`absolute left-[68%] top-1/2 aspect-video w-[max(100vw,177.78svh)] max-w-none -translate-x-[68%] -translate-y-1/2 transition-opacity duration-500 ${
                videoReady ? 'opacity-100' : 'opacity-0'
              }`}
            />
          )}
          </div>
        </div>

        {/* ---- Signature-like raid mark, layered over the portrait ---- */}
        <div
          data-hero-signature
          aria-hidden="true"
          className="nr-signature pointer-events-none absolute left-1/2 top-[53%] z-20 opacity-0"
        >
          <span className="nr-signature-word">NightRaid</span>
          <span className="nr-signature-swoop" />
        </div>

      </div>
    </section>
  )
}
