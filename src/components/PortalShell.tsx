import { ReactNode } from 'react'
import { ArrowLeft } from 'lucide-react'

interface PortalShellProps {
  eyebrow: string
  title: string
  accent?: string
  kicker: string
  children: ReactNode
}

export default function PortalShell({ eyebrow, title, accent, kicker, children }: PortalShellProps) {
  return (
    <div className="nr-site-surface min-h-screen bg-paper text-bone">
      <header className="border-b border-bone/10">
        <div className="mx-auto flex w-full max-w-[110rem] items-center justify-between px-5 py-5 sm:px-8 lg:px-12">
          <a href="/" aria-label="Back to NIGHTRAID home" className="text-bone">
            <span className="block font-serif text-2xl uppercase leading-[0.85]">Night</span>
            <span className="block font-display text-[1.35rem] uppercase leading-[0.95] tracking-[0.1em]">Raid</span>
          </a>
          <a href="/#apply" className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-[0.12em] text-bone/55 transition-colors hover:text-blood">
            <ArrowLeft className="h-4 w-4" /> Back to site
          </a>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[110rem] px-5 py-16 sm:px-8 sm:py-24 lg:px-12">
        <p className="ln-label text-blood">{eyebrow}</p>
        <h1 className="mt-5 text-[clamp(2.8rem,7vw,6.5rem)] uppercase leading-[0.9] text-bone">
          <span className="font-display">{title}</span>
          {accent && <> <span className="ln-serif text-blood">{accent}</span></>}
        </h1>
        <p className="mt-6 max-w-2xl text-sm leading-relaxed text-bone/50 sm:text-base">{kicker}</p>
        <div className="mt-12 sm:mt-16">{children}</div>
      </main>
    </div>
  )
}
