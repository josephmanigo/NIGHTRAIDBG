import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { gsap, ScrollTrigger, prefersReducedMotion } from '../lib/motion'
import SectionHeader from './SectionHeader'

/* Loading three.js lazily keeps ~1 MB of WebGL code off the critical path;
 * it only downloads when the section comes within mounting range below. */
const InfiniteGallery = lazy(() => import('@/components/ui/3d-gallery-photography'))

/** Trophy wall — certificates fly past the camera once, then release the scroll. */
const ACHIEVEMENT_IMAGES = [
  { src: '/images/achievement-19.jpeg', alt: 'NIGHTRAID Starks — Top 2 at Blood Strike Masters SEA' },
  { src: '/images/achievement-16.jpeg', alt: 'NIGHTRAID Abyss — Top 6 at Blood Strike Masters SEA' },
  { src: '/images/achievement-15.jpeg', alt: 'NIGHTRAID Mantas — Top 11 at Blood Strike Masters SEA' },
  { src: '/images/achievement-1.png', alt: 'NIGHTRAID Rage — Ethereal Scrimmage Champion' },
  { src: '/images/achievement-2.png', alt: 'NIGHTRAID Rage — Warlords Fast Tour Champions' },
  { src: '/images/achievement-8.png', alt: 'NIGHTRAID Abyss — PHGG Cup S2 Daily Champion' },
  { src: '/images/achievement-10.png', alt: 'NIGHTRAID Deso — SG Esports PH PC Scrimmage June Champion' },
  { src: '/images/achievement-5.png', alt: 'NIGHTRAID Deso — SG Esports PH PC Scrimmage April Champion' },
  { src: '/images/achievement-9.png', alt: 'NIGHTRAID Skadi — PH Gaming Guild Champion' },
  { src: '/images/achievement-3.png', alt: 'NIGHTRAID Farlight 84 Deathmatch Champions' },
  { src: '/images/achievement-4.png', alt: 'NIGHTRAID Deso — MIPH Esports PC Scrimmage First Place' },
  { src: '/images/achievement-6.png', alt: 'NIGHTRAID Deso — Light Division Cup Runner-Up' },
  { src: '/images/achievement-7.png', alt: 'NIGHTRAID Abyss — PHGG Cup S2 Third Place' },
  { src: '/images/achievement-11.png', alt: 'NIGHTRAID Geek Creators Cup Second Place' },
  { src: '/images/achievement-14.jpeg', alt: 'NIGHTRAID Abyss Qualified to BSM SEA' },
  { src: '/images/achievement-17.jpeg', alt: 'NIGHTRAID Mantas Qualified to BSM SEA' },
  { src: '/images/achievement-18.png', alt: 'NIGHTRAID Starks Invited BSM SEA' },
  { src: '/images/achievement-12.png', alt: 'NIGHTRAID Abyss Finalist Graphic' },
  // NR Scrims photos
  { src: '/images/achievement-20.png', alt: 'NIGHTRAID Good Luck Graphic' },
  { src: '/images/achievement-21.png', alt: 'NIGHTRAID E-Cert Achievement' },
  { src: '/images/achievement-22.png', alt: 'NIGHTRAID Fitness Esports Post' },
  { src: '/images/achievement-23.png', alt: 'NIGHTRAID Dynamic Esports Game Day' },
  { src: '/images/achievement-24.png', alt: 'NIGHTRAID NSN Scrims Champions' },
  { src: '/images/achievement-25.png', alt: 'NIGHTRAID Project Name Achievement' },
  { src: '/images/achievement-26.png', alt: 'NIGHTRAID Achievement Graphic' },
  { src: '/images/achievement-27.png', alt: 'NIGHTRAID Achievement Graphic 2' },
  { src: '/images/achievement-28.png', alt: 'NIGHTRAID June Scrims Achievement' },
  { src: '/images/achievement-29.png', alt: 'NIGHTRAID May Scrims Achievement' },
  { src: '/images/achievement-30.png', alt: 'NIGHTRAID Scrims Achievement' },
  { src: '/images/achievement-31.jpg', alt: 'NIGHTRAID Scrimmage Photo' },
  { src: '/images/achievement-32.jpg', alt: 'NIGHTRAID Scrimmage Photo 2' },
  { src: '/images/achievement-33.jpg', alt: 'NIGHTRAID Scrimmage Photo 3' },
  { src: '/images/achievement-34.jpg', alt: 'NIGHTRAID Scrimmage Photo 4' },
  { src: '/images/achievement-35.jpg', alt: 'NIGHTRAID Scrimmage Photo 5' },
  { src: '/images/achievement-36.jpg', alt: 'NIGHTRAID Scrimmage Photo 6' },
  { src: '/images/achievement-37.jpg', alt: 'NIGHTRAID Scrimmage Photo 7' },
  { src: '/images/achievement-38.jpg', alt: 'NIGHTRAID Scrimmage Photo 8' },
  { src: '/images/achievement-39.jpg', alt: 'NIGHTRAID Scrimmage Photo 9' },
  { src: '/images/achievement-40.jpg', alt: 'NIGHTRAID Scrimmage Photo 10' },
  { src: '/images/achievement-41.jpg', alt: 'NIGHTRAID Scrimmage Photo 11' },
  { src: '/images/achievement-42.jpg', alt: 'NIGHTRAID Scrimmage Photo 12' },
]

export default function Achievements() {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const progressRef = useRef(0)
  const reduced = prefersReducedMotion()
  const [shouldMountGallery, setShouldMountGallery] = useState(false)

  /* Defer mounting the WebGL gallery (42 textures) until this section is
   * within reach. Mounting it eagerly at page load competes with the
   * preloader and the hero background video for the main thread and
   * network right when that matters most, causing a stutter on the
   * preloader-to-hero handoff. */
  useEffect(() => {
    const el = wrapperRef.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') {
      setShouldMountGallery(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setShouldMountGallery(true)
          observer.disconnect()
        }
      },
      { rootMargin: '150% 0px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  /* Progress is tied 1:1 to the sticky panel's pinned scroll range — it hits
   * 1 exactly when the wrapper's bottom reaches the viewport bottom, which is
   * also when CSS `sticky` naturally releases the panel into normal scroll. */
  useEffect(() => {
    const el = wrapperRef.current
    if (!el || reduced) return
    const ctx = gsap.context(() => {
      ScrollTrigger.create({
        trigger: el,
        start: 'top top',
        end: 'bottom bottom',
        // A scrub lag (instead of `true`) eases the fly-through behind the
        // actual scroll position, so fast flicks glide instead of snapping.
        scrub: 2.5,
        onUpdate: (self) => {
          progressRef.current = self.progress
        },
      })
    })
    return () => ctx.revert()
  }, [reduced])

  return (
    // 42 photos — each gets ~40vh of unhurried scroll time.
    <div ref={wrapperRef} className={reduced ? 'relative' : 'relative h-[1800vh]'}>
      <section
        id="achievements"
        aria-labelledby="achievements-title"
        data-theme="dark"
        className={`overflow-hidden text-white ${reduced ? 'relative h-[95svh] md:h-[110svh]' : 'sticky top-0 h-screen'}`}
      >
        {shouldMountGallery && (
          <Suspense fallback={null}>
            <InfiniteGallery
              images={ACHIEVEMENT_IMAGES}
              progressRef={progressRef}
              zSpacing={6}
              fadeSettings={{ fadeIn: { start: 0.0, end: 0.15 }, fadeOut: { start: 0.85, end: 1.0 } }}
              blurSettings={{ blurIn: { start: 0.0, end: 0.12 }, blurOut: { start: 0.88, end: 1.0 }, maxBlur: 3.0 }}
              className="absolute inset-0 h-full w-full"
            />
          </Suspense>
        )}

        {/* Header overlay (floating, centered on top) */}
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center">
          <div className="mx-auto w-full max-w-[110rem] px-5 sm:px-8 lg:px-12">
            <SectionHeader title="Proven in" accent="battle" tone="dark" />
          </div>
        </div>

        {/* Soft edges — the canvas melts into the continuous page surface */}

        {/* Skip-to-next arrow */}
        <button
          id="achievements-skip"
          aria-label="Skip to next section"
          onClick={() => {
            document.getElementById('merch')?.scrollIntoView({ behavior: 'smooth' })
          }}
          className="absolute bottom-8 left-1/2 z-20 -translate-x-1/2 flex h-8 w-8 items-center justify-center rounded-full border border-white/20 bg-white/5 backdrop-blur-sm text-white/60 transition-all duration-300 hover:border-white/50 hover:bg-white/15 hover:text-white hover:scale-110"
          style={{ animation: 'achievements-bob 2s ease-in-out infinite' }}
        >
          {/* Chevron down */}
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M2 4.5L6 8.5L10 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>

        <style>{`
          @keyframes achievements-bob {
            0%, 100% { transform: translateX(-50%) translateY(0); }
            50%       { transform: translateX(-50%) translateY(5px); }
          }
        `}</style>
      </section>
    </div>
  )
}
