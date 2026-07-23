import { useEffect, useState } from 'react'
import { LogIn } from 'lucide-react'
import { scrollToId } from '../lib/scroll'
import MobileMenu from './MobileMenu'

interface HeaderProps {
  activeSection: string
}

/** Minimal floating header: stacked serif/sans wordmark, blood store pill
 *  and a burger that opens the full-screen menu on every breakpoint.
 *  The wordmark flips ink/bone depending on the section underneath it
 *  (sections marked with data-theme="dark"). */
export default function Header({ activeSection }: HeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [overDark, setOverDark] = useState(false)

  useEffect(() => {
    let raf = 0
    const probe = () => {
      raf = 0
      const darkSections = document.querySelectorAll<HTMLElement>('[data-theme="dark"]')
      const y = 56 // sample line just under the wordmark's baseline
      let dark = false
      darkSections.forEach((el) => {
        const r = el.getBoundingClientRect()
        if (r.top <= y && r.bottom >= y) dark = true
      })
      setOverDark(dark)
    }
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(probe)
    }
    probe()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
    }
  }, [])

  const go = (id: string) => (e: React.MouseEvent) => {
    e.preventDefault()
    scrollToId(id)
  }

  return (
    <header className="fixed inset-x-0 top-0 z-70">
      <div className="flex w-full items-start justify-between px-4 py-5 sm:px-6 lg:px-8">
        <a
          href="#home"
          onClick={go('home')}
          aria-label="NIGHTRAID — back to top"
          className={`relative z-70 transition-colors duration-500 ${overDark ? 'text-bone' : 'text-ink'}`}
        >
          <span className="block font-serif text-[1.55rem] uppercase leading-[0.85] tracking-[0.04em] sm:text-3xl">
            Night
          </span>
          <span className="block font-display text-[1.45rem] uppercase leading-[0.95] tracking-[0.1em] sm:text-[1.7rem]">
            Raid
          </span>
        </a>

        <div className="relative z-70 flex items-center gap-3">
          <a
            href="/admin/login"
            aria-label="Administrator login"
            title="Admin login"
            className={`flex h-11 w-11 items-center justify-center rounded-full border transition-colors duration-300 hover:border-blood hover:bg-blood hover:text-bone sm:h-12 sm:w-12 ${
              overDark ? 'border-bone/20 text-bone' : 'border-ink/20 text-ink'
            }`}
          >
            <LogIn className="h-5 w-5" />
          </a>
          <button
            type="button"
            onClick={() => setMenuOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={menuOpen}
            aria-label="Open menu"
            className="group flex h-14 w-14 flex-col items-center justify-center gap-1.5 border-0 bg-transparent p-2 shadow-none outline-none transition-transform duration-300 hover:-translate-y-0.5 focus:outline-none sm:h-16 sm:w-16"
          >
            <span aria-hidden="true" className="block h-[2.5px] w-6 rounded-full bg-bone transition-colors duration-300 group-hover:bg-blood" />
            <span aria-hidden="true" className="block h-[2.5px] w-4 rounded-full bg-bone transition-colors duration-300 group-hover:bg-blood" />
          </button>
        </div>
      </div>

      <MobileMenu open={menuOpen} onClose={() => setMenuOpen(false)} activeSection={activeSection} />
    </header>
  )
}
