import { ArrowLeft } from 'lucide-react'
import Application from './Application'

/** Standalone `/apply` page. Discord OAuth returns here so applicants land
 * directly back in the application flow instead of the marketing hero. */
export default function ApplyPage() {
  return (
    <div className="nr-site-surface min-h-screen bg-paper text-bone">
      <header>
        <div className="mx-auto flex w-full max-w-[110rem] items-center justify-between px-5 py-5 sm:px-8 lg:px-12">
          <a href="/" aria-label="Back to NIGHTRAID home" className="shrink-0 text-bone">
            <span className="block font-serif text-3xl uppercase leading-[0.85] tracking-[0.04em]">Night</span>
            <span className="block font-display text-[1.7rem] uppercase leading-[0.95] tracking-[0.1em]">Raid</span>
          </a>
          <a href="/" className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-[0.12em] text-bone/55 transition-colors hover:text-blood">
            <ArrowLeft className="h-4 w-4" /> Back to site
          </a>
        </div>
      </header>
      <main>
        <Application />
      </main>
    </div>
  )
}
