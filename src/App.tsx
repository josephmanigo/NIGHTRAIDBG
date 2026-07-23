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
import Application from './components/Application'
import ApplicationStatusPage from './components/ApplicationStatusPage'
import AdminApplicationsPage from './components/AdminApplicationsPage'
import Footer from './components/Footer'

export default function App() {
  if (window.location.pathname === '/application/status') return <ApplicationStatusPage />
  if (window.location.pathname === '/admin/applications') return <AdminApplicationsPage />
  return <MarketingSite />
}

function MarketingSite() {
  useSmoothScroll(true)
  useMagnetic()

  const isApplyRoute = window.location.pathname === '/apply'

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

  /* `/apply` is the shareable form URL while `/#apply` remains the
   * in-page navigation target on the marketing site. */
  useEffect(() => {
    if (!isApplyRoute) return

    const frame = window.requestAnimationFrame(() => {
      const application = document.getElementById('apply')
      if (!application) return
      window.scrollTo({ top: Math.max(0, application.offsetTop - 72), behavior: 'auto' })
    })

    return () => window.cancelAnimationFrame(frame)
  }, [isApplyRoute])

  return (
    <>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      {!isApplyRoute && <Preloader />}
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

          {/* Card-stack zone: Footer slides up like a card over the final section. */}
          <div className="relative isolate">
            <div>
              <Merch />
              <Application />
            </div>
            {/* Footer is sticky so it "peels" up over the application section. */}
            <Footer />
          </div>
        </main>
      </div>
    </>
  )
}
