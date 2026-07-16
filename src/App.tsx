import { useEffect, useMemo } from 'react'
import { ScrollTrigger } from './lib/motion'
import { useSmoothScroll } from './hooks/useSmoothScroll'
import { useSectionSpy } from './hooks/useSectionSpy'
import { useMagnetic } from './hooks/useMagnetic'
import { NAV_ITEMS } from './data/site'
import Preloader from './components/Preloader'
import Header from './components/Header'
import Hero from './components/Hero'
import About from './components/About'
import Members from './components/Members'
import Management from './components/Management'
import Events from './components/Events'
import Achievements from './components/Achievements'
import Merch from './components/Merch'
import Footer from './components/Footer'

export default function App() {
  useSmoothScroll(true)
  useMagnetic()

  const sectionIds = useMemo(() => NAV_ITEMS.map((n) => n.id), [])
  const activeSection = useSectionSpy(sectionIds)

  /* Keep ScrollTrigger measurements honest once fonts and media settle. */
  useEffect(() => {
    let cancelled = false
    const refresh = () => {
      if (!cancelled) ScrollTrigger.refresh()
    }
    if (document.fonts?.ready) document.fonts.ready.then(refresh)
    window.addEventListener('load', refresh)
    return () => {
      cancelled = true
      window.removeEventListener('load', refresh)
    }
  }, [])

  return (
    <>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <Preloader />
      <Header activeSection={activeSection} />
      {/* One continuous surface — sections are transparent so the color and
       * topo pattern flow unbroken from hero to footer, no visible seams. */}
      <div className="nr-site-surface relative bg-paper">
        <Hero />
        <main id="main">
          <About />
          <Members />
          <Management />
          <Events />
          <Achievements />

          {/* Card-stack zone: Footer slides up like a card rising over Merch */}
          <div className="relative isolate">
            {/* Merch renders in normal flow and provides the scroll height */}
            <div>
              <Merch />
            </div>
            {/* Footer is sticky so it "peels" up and overlaps Merch as you scroll */}
            <Footer />
          </div>
        </main>
      </div>
    </>
  )
}
