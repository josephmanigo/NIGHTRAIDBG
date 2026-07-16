import { useEffect, useRef } from 'react'
import { gsap, prefersReducedMotion } from '../lib/motion'
import { useCountUp, useReveal } from '../hooks/useReveal'
import { STATS, ORG } from '../data/site'

/* Manifesto words. `serif` renders in blood italic serif; `redact` words are
 * hidden behind a blood block that wipes away at the end of the scrub. */
const STATEMENT: Array<{ text: string; serif?: boolean; redact?: boolean }> = [
  { text: 'Built' },
  { text: 'in' },
  { text: 'darkness,', serif: true },
  { text: 'proven' },
  { text: 'under' },
  { text: 'pressure.', serif: true },
  { text: 'Five' },
  { text: 'squads,' },
  { text: 'one' },
  { text: 'banner', serif: true },
  { text: '—' },
  { text: 'raised' },
  { text: 'in' },
  { text: 'the' },
  { text: 'Philippines,' },
  { text: 'tested' },
  { text: 'across' },
  { text: 'SEA,' },
  { text: 'growing' },
  { text: 'together', serif: true },
  { text: 'night' },
  { text: 'after' },
  { text: 'night.', redact: true },
]

function Stat({ value, suffix, label }: { value: number; suffix: string; label: string }) {
  const ref = useCountUp<HTMLSpanElement>(value, suffix)
  return (
    <div className="text-center">
      <span ref={ref} className="font-display text-5xl leading-none text-bone sm:text-6xl">
        0{suffix}
      </span>
      <p className="ln-label mt-3 text-bone/50">{label}</p>
    </div>
  )
}

export default function About() {
  const statementRef = useRef<HTMLParagraphElement>(null)
  const footRef = useReveal<HTMLDivElement>({ selector: '[data-reveal]', stagger: 0.12 })

  /* Word-by-word brighten scrubbed to scroll, then the blood redactions wipe. */
  useEffect(() => {
    const el = statementRef.current
    if (!el || prefersReducedMotion()) return
    const ctx = gsap.context(() => {
      const tl = gsap.timeline({
        scrollTrigger: {
          trigger: el,
          start: 'top 80%',
          end: 'bottom 45%',
          scrub: true,
        },
      })
      tl.fromTo(
        el.querySelectorAll('[data-st-word]'),
        { opacity: 0.14 },
        { opacity: 1, stagger: 0.05, ease: 'none' },
      ).to(
        el.querySelectorAll('[data-st-redact]'),
        { scaleX: 0, transformOrigin: 'right center', stagger: 0.12, ease: 'none' },
        '>-0.2',
      )
    }, el)
    return () => ctx.revert()
  }, [])

  return (
    <section
      id="about"
      aria-labelledby="about-title"
      data-theme="dark"
      className="relative overflow-hidden"
    >
      <div className="relative mx-auto w-full max-w-[110rem] px-5 py-24 sm:px-8 sm:py-32 lg:px-12">
        <h2 id="about-title" className="sr-only">
          About NIGHTRAID
        </h2>

        {/* Giant manifesto */}
        <p
          ref={statementRef}
          className="mx-auto max-w-6xl text-center font-display text-[clamp(2rem,5.6vw,4.8rem)] uppercase leading-[1.04] text-bone"
        >
          {STATEMENT.map((w, i) => (
            <span
              key={i}
              data-st-word
              className={`relative inline-block ${i < STATEMENT.length - 1 ? 'mr-[0.26em]' : ''}`}
            >
              <span className={w.serif ? 'ln-serif text-blood' : undefined}>{w.text}</span>
              {w.redact && (
                <span
                  data-st-redact
                  aria-hidden="true"
                  className="absolute -inset-x-1 inset-y-0 bg-blood motion-reduce:hidden"
                />
              )}
            </span>
          ))}
        </p>

        <div ref={footRef} className="mx-auto mt-20 max-w-5xl sm:mt-28">
          {/* Stats row */}
          <div data-reveal className="grid grid-cols-2 gap-x-6 gap-y-12 border-t border-haze pt-12 lg:grid-cols-4">
            {STATS.map((s) => (
              <Stat key={s.label} value={s.value} suffix={s.suffix} label={s.label} />
            ))}
          </div>

          {/* Founder line */}
          <blockquote data-reveal className="mt-16 text-center sm:mt-20">
            <p className="mx-auto max-w-3xl font-serif text-xl italic leading-relaxed text-bone/80 sm:text-2xl">
              “It's never just about the wins — it's late-night grinds, laughs with friends, and
              seeing everyone grow together.”
            </p>
            <footer className="ln-label mt-5 text-blood">— Emerald, Founder</footer>
          </blockquote>

          <p data-reveal className="ln-label mt-14 text-center text-bone/40">
            {ORG.games.join(' · ')}
          </p>
        </div>
      </div>
    </section>
  )
}
