import { useEffect, useRef } from 'react'
import { NAV_ITEMS, SOCIAL_LINKS } from '../data/site'
import { scrollToId } from '../lib/scroll'
import { gsap, prefersReducedMotion } from '../lib/motion'
import { motion } from 'motion/react'
import TextRoll from './ui/TextRoll'

export default function Footer() {
  const statementRef = useRef<HTMLParagraphElement>(null)

  /* Statement rises as the footer enters the viewport. */
  useEffect(() => {
    const el = statementRef.current
    if (!el || prefersReducedMotion()) return
    const ctx = gsap.context(() => {
      gsap.from(el, {
        yPercent: 30,
        autoAlpha: 0,
        duration: 1.1,
        ease: 'power3.out',
        scrollTrigger: { trigger: el, start: 'top 92%', once: true },
      })
    })
    return () => ctx.revert()
  }, [])

  const year = new Date().getFullYear()

  return (
    <footer
      data-theme="dark"
      className="sticky top-0 relative overflow-hidden rounded-tl-[2rem] rounded-tr-[2rem] shadow-[0_-8px_40px_rgba(0,0,0,0.45)]"
      aria-label="Site footer"
    >
      <div className="mx-auto w-full max-w-[110rem] px-5 pt-24 sm:px-8 sm:pt-32 lg:px-12">
        {/* Signature mark + giant statement */}
        <p aria-hidden="true" className="ln-serif text-center text-3xl text-blood sm:text-4xl">
          暗NR
        </p>
        <p
          ref={statementRef}
          className="mx-auto mt-6 max-w-6xl text-center text-[clamp(2.4rem,7vw,6.5rem)] uppercase leading-[0.95] text-bone"
        >
          <span className="font-display">Always raiding</span>{' '}
          <span className="ln-serif text-blood">the night</span>
          <span className="font-display">.</span>
        </p>

        {/* Pages / centre image / follow — reference footer layout */}
        <div className="mt-16 grid items-center gap-12 sm:mt-20 lg:grid-cols-3">
          <nav aria-label="Footer navigation" className="text-center lg:text-left">
            <p className="ln-label mb-4 text-bone/40">Pages</p>
            <ul className="space-y-1.5">
              {NAV_ITEMS.map((item) => (
                <li key={item.id} className="flex justify-center lg:justify-start">
                  <motion.a
                    href={`#${item.id}`}
                    onClick={(e) => {
                      e.preventDefault()
                      scrollToId(item.id)
                    }}
                    className="font-display text-xl uppercase leading-tight text-bone transition-colors hover:text-blood sm:text-2xl flex items-center"
                    initial="initial"
                    whileHover="hovered"
                  >
                    <TextRoll>{item.label}</TextRoll>
                  </motion.a>
                </li>
              ))}
            </ul>
          </nav>

          <div className="relative order-first mx-auto w-full max-w-[12rem] md:max-w-[14rem] lg:order-none flex justify-center">
            <img
              src="/images/nightraid-favicon.png"
              alt="NIGHTRAID Logo"
              loading="lazy"
              className="w-full h-auto object-contain"
            />
          </div>

          <div className="text-center lg:text-right">
            <p className="ln-label mb-4 text-bone/40">Follow on</p>
            <ul className="space-y-1.5">
              {SOCIAL_LINKS.map((s) => (
                <li key={s.label} className="flex justify-center lg:justify-end">
                  <motion.a
                    href={s.href}
                    target="_blank"
                    rel="noreferrer"
                    className="font-display text-xl uppercase leading-tight text-bone transition-colors hover:text-blood sm:text-2xl flex items-center"
                    initial="initial"
                    whileHover="hovered"
                  >
                    <TextRoll>{s.label}</TextRoll>
                  </motion.a>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Dynamic margin for spacing */}
        <div className="pb-16" />
      </div>

      <div className="border-t border-haze">
        <div className="mx-auto flex w-full max-w-[110rem] flex-wrap items-center justify-between gap-3 px-5 py-5 sm:px-8 lg:px-12">
          <p className="ln-label text-[0.58rem] text-bone/40">
            © {year} NIGHTRAID Esports. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  )
}
