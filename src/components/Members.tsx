import { useMemo, useState } from 'react'
import { TEAMS, COMMUNITY_MEMBERS, TEAM_STATUS_FILTERS, type TeamStatusFilter } from '../data/teams'
import { CircularGallery, type GalleryItem } from './ui/circular-gallery'
import SectionHeader from './SectionHeader'
import Marquee from './Marquee'
import { useReveal } from '../hooks/useReveal'

export default function Members() {
  const ref = useReveal<HTMLDivElement>({ selector: '[data-reveal]', stagger: 0.15 })
  const [statusFilter, setStatusFilter] = useState<TeamStatusFilter>('All')

  const teams = useMemo(() => {
    const base = TEAMS.filter((team) => team.id !== 'deso')
    if (statusFilter === 'All') return base
    return base.filter((team) => team.status === statusFilter.toLowerCase())
  }, [statusFilter])

  const galleryItems = useMemo<GalleryItem[]>(
    () =>
      teams.map((team) => ({
        common: team.name,
        binomial: `${team.game} · ${team.division}`,
        photo: {
          url: team.image,
          text: team.imageAlt,
          pos: 'center top',
          by: team.headline,
        },
      })),
    [teams],
  )

  const single = teams.length === 1

  return (
    <section id="members" aria-label="NIGHTRAID members" className="relative overflow-hidden">
      <div className="mx-auto w-full max-w-[110rem] px-5 py-24 sm:px-8 sm:py-32 lg:px-12">
        <SectionHeader
          title="The"
          accent="raiders"
          kicker="These are NIGHTRAID’s competitive players."
        />

        {/* Filters — z-10 so the gallery's negative-translate hit area below can't intercept clicks */}
        <div
          role="tablist"
          aria-label="Filter teams"
          className="relative z-10 mb-10 flex flex-wrap items-center justify-center gap-4 text-xs font-bold uppercase tracking-wider text-ink/50"
        >
          {TEAM_STATUS_FILTERS.map((f, idx) => (
            <span key={f} className="flex items-center gap-4">
              {idx > 0 && <span className="select-none text-ink/20">/</span>}
              <button
                role="tab"
                aria-selected={statusFilter === f}
                onClick={() => setStatusFilter(f)}
                className={`uppercase tracking-widest transition-colors duration-200 hover:text-blood ${
                  statusFilter === f ? 'font-extrabold text-blood' : 'text-ink/60'
                }`}
              >
                {f === 'All' ? 'All' : `${f} Compe Team`}
              </button>
            </span>
          ))}
        </div>

        <p aria-live="polite" className="sr-only">
          {teams.length} team{teams.length === 1 ? '' : 's'} shown
        </p>

        <div ref={ref}>
          <div data-reveal className="relative -mx-5 sm:-mx-8 lg:-mx-12">
            {single ? (
              <div className="flex h-[34rem] items-center justify-center sm:h-[42rem] lg:h-[48rem]">
                <div className="w-full max-w-[20rem] sm:max-w-[24rem] lg:max-w-[26rem]">
                  <div className="group relative aspect-[4/5] w-full overflow-hidden rounded-2xl border border-line bg-paper-deep/60 backdrop-blur-lg">
                    <img
                      src={teams[0].image}
                      alt={teams[0].imageAlt}
                      className="absolute inset-0 h-full w-full object-cover object-[center_top]"
                    />
                  </div>
                </div>
              </div>
            ) : (
              <>
                <CircularGallery
                  items={galleryItems}
                  radius={350}
                  autoRotateSpeed={0.035}
                  className="h-[34rem] -translate-y-12 sm:h-[42rem] sm:-translate-y-[4.5rem] lg:h-[48rem]"
                />

                <p className="ln-label absolute inset-x-0 bottom-0 text-center text-bone/35 sm:hidden">
                  Swipe to rotate
                </p>
              </>
            )}
          </div>

          <div data-reveal className="relative -mt-8 overflow-hidden rounded-3xl border border-line bg-paper-deep/50 py-8 sm:-mt-12">
            <Marquee
              text={COMMUNITY_MEMBERS.slice(0, 33).join(' · ')}
              repeat={2}
              className="ln-label text-ink/50"
            />
            <Marquee
              text={COMMUNITY_MEMBERS.slice(33, 66).join(' · ')}
              repeat={2}
              className="ln-label mt-4 -translate-x-10 text-ink/40"
            />
            <Marquee
              text={COMMUNITY_MEMBERS.slice(66).join(' · ')}
              repeat={2}
              className="ln-label mt-4 translate-x-10 text-ink/30"
            />
            <div className="mt-4 flex flex-wrap items-center justify-between gap-4 px-6 sm:px-10">
              <p className="text-3xl uppercase text-ink sm:text-4xl">
                <span className="font-display">{COMMUNITY_MEMBERS.length}+ members</span>{' '}
                <span className="ln-serif">strong</span>
              </p>
              <p className="ln-label text-ink/45">Official members list · 暗NR</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
