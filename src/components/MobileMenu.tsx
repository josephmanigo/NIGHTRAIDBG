import { useRef } from 'react'
import { NAV_ITEMS, SOCIAL_LINKS } from '../data/site'
import { scrollToId } from '../lib/scroll'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { AnimatePresence, motion } from 'motion/react'
import TextRoll from './ui/TextRoll'

interface MobileMenuProps {
  open: boolean
  onClose: () => void
  activeSection: string
}

/** Full-screen navigation overlay with staggered link entrance,
 *  scroll locking, focus trapping and Escape support. */
export default function MobileMenu({ open, onClose, activeSection }: MobileMenuProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef, open, onClose)

  const go = (id: string) => (e: React.MouseEvent) => {
    e.preventDefault()
    onClose()
    // Let the scroll lock release before smooth-scrolling
    requestAnimationFrame(() => scrollToId(id))
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-label="Site navigation"
          className="nr-mobile-menu nr-site-surface fixed inset-0 z-80 flex flex-col"
          initial={{ opacity: 0, clipPath: 'inset(0 0 100% 0)' }}
          animate={{ opacity: 1, clipPath: 'inset(0 0 0% 0)' }}
          exit={{ opacity: 0, clipPath: 'inset(0 0 100% 0)' }}
          transition={{ duration: 0.65, ease: [0.65, 0.05, 0, 1] }}
        >
      <div className="flex items-start justify-between px-4 py-5 sm:px-6 lg:px-8">
        <span aria-hidden="true">
          <span className="block font-serif text-[1.55rem] uppercase leading-[0.85] tracking-[0.04em] text-bone sm:text-3xl">Night</span>
          <span className="block font-display text-[1.45rem] uppercase leading-[0.95] tracking-[0.1em] text-bone sm:text-[1.7rem]">
            Raid
          </span>
        </span>
        <button
          type="button"
          onClick={onClose}
          className="p-2 text-2xl text-bone transition-colors hover:text-blood"
          aria-label="Close menu"
        >
          ✕
        </button>
      </div>

      <nav
        aria-label="Primary"
        className="flex flex-1 flex-col justify-center items-center gap-2 overflow-y-auto px-6 pb-6 text-center"
      >
        {NAV_ITEMS.map((item, i) => {
          const active = activeSection === item.id
          return (
            <motion.a
              key={item.id}
              href={`#${item.id}`}
              onClick={go(item.id)}
              aria-current={active ? 'true' : undefined}
              className="group flex w-full items-center justify-center overflow-hidden py-2 text-center"
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              transition={{ duration: 0.45, delay: 0.16 + i * 0.045, ease: [0.65, 0.05, 0, 1] }}
              whileHover="hovered"
            >
              <TextRoll
                center
                className={`font-display text-[clamp(2.2rem,7vw,3.6rem)] uppercase leading-none transition-colors duration-300 ${
                  active ? 'text-blood' : 'text-bone group-hover:text-blood'
                }`}
              >
                {item.label}
              </TextRoll>
            </motion.a>
          )
        })}
      </nav>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-haze px-6 py-5 sm:px-12">
        <span className="ln-label text-bone/50">Raid the night. Rule the game.</span>
        <div className="flex gap-5">
          {SOCIAL_LINKS.map((s) => (
            <motion.a
              key={s.label}
              href={s.href}
              target="_blank"
              rel="noreferrer"
              className="ln-label flex items-center overflow-hidden text-bone/60 transition-colors hover:text-blood"
              initial="initial"
              whileHover="hovered"
            >
              <TextRoll>{s.label}</TextRoll>
            </motion.a>
          ))}
        </div>
      </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
