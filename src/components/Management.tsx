import { useReveal } from '../hooks/useReveal'
import {
  LEADERS,
  FOUNDER_QUOTE,
  MANAGEMENT_IMAGE,
  MANAGEMENT_IMAGE_ALT,
} from '../data/management'
import SectionHeader from './SectionHeader'

export default function Management() {
  const ref = useReveal<HTMLDivElement>({ selector: '[data-reveal]', stagger: 0.09 })
  const founder = LEADERS.find((l) => l.tier === 'founder')!
  const cofounder = LEADERS.find((l) => l.tier === 'cofounder')!
  const admins = LEADERS.filter((l) => l.tier === 'admin')

  return (
    <section id="management" aria-labelledby="management-title" data-theme="dark" className="relative overflow-hidden">
      {/* Full-bleed image break, reference style — melts into the shared surface top and bottom */}
      <div className="relative">
        <img
          src={MANAGEMENT_IMAGE}
          alt={MANAGEMENT_IMAGE_ALT}
          loading="lazy"
          width={4096}
          height={2304}
          className="h-[42svh] w-full object-cover sm:h-[62svh]"
        />
        <span aria-hidden="true" className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-paper to-transparent" />
        <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-paper to-transparent" />
        {/* Notched caption chip cut into the image */}
        <span className="ln-notch absolute bottom-0 right-0 hidden items-baseline gap-2.5 bg-paper py-3 pl-8 pr-6 sm:flex">
          <span className="font-display text-xl uppercase leading-none text-bone">The command line</span>
          <span className="ln-label text-blood">Est. 2024</span>
        </span>
      </div>

      <div className="relative mx-auto w-full max-w-[110rem] px-5 pb-24 pt-16 sm:px-8 sm:pb-32 sm:pt-20 lg:px-12">
        <SectionHeader
          title="Command"
          accent="crew"
          kicker="The people who keep ninety raiders moving in one direction — founders first, admins on every flank."
          tone="dark"
        />

        <div ref={ref} className="mx-auto max-w-6xl">
          {/* Founders */}
          <div className="grid gap-4 sm:grid-cols-2">
            {[founder, cofounder].map((leader) => (
              <div
                key={leader.id}
                data-reveal
                className="rounded-2xl border border-haze bg-bone/[0.04] p-6 sm:p-8"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="font-display text-3xl uppercase leading-none text-bone sm:text-4xl">
                    {leader.name}
                  </h3>
                  <span className="ln-label text-blood">{leader.role}</span>
                </div>
                <p className="mt-3 text-sm leading-relaxed text-bone/55">{leader.bio}</p>
              </div>
            ))}
          </div>

          {/* Quote */}
          <blockquote data-reveal className="my-14 text-center sm:my-16">
            <p className="mx-auto max-w-3xl font-serif text-xl italic leading-relaxed text-bone/80 sm:text-2xl">
              “{FOUNDER_QUOTE}”
            </p>
            <footer className="ln-label mt-4 text-bone/45">
              {founder.name} · {founder.role}
            </footer>
          </blockquote>

          {/* Admins */}
          <p data-reveal className="ln-label mb-4 text-bone/45">
            Admins
          </p>
          <ul data-reveal className="grid auto-rows-fr gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {admins.map((leader) => (
              <li
                key={leader.id}
                className="group rounded-xl border border-haze px-5 py-5 transition-colors duration-300 hover:border-blood/60"
              >
                <p className="ln-label text-[0.55rem] text-blood/80 transition-colors duration-300 group-hover:text-blood">
                  {leader.role}
                </p>
                <h4 className="mt-2 font-display text-2xl uppercase leading-none text-bone">{leader.name}</h4>
                <p className="mt-2 text-xs leading-relaxed text-bone/45">{leader.bio}</p>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  )
}
