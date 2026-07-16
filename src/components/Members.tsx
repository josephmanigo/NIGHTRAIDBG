import { useMemo, useState } from 'react'
import { TEAMS, COMMUNITY_MEMBERS, TEAM_STATUS_FILTERS, type TeamStatusFilter } from '../data/teams'
import { CircularGallery, REFERENCE_RADIUS, type GalleryItem } from './ui/circular-gallery'
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
  /* Keep the on-screen gap between adjacent cards constant regardless of how
   * many teams a filter leaves — the gallery spaces items evenly around a
   * fixed-radius circle, so fewer items (a wider angle apart) would
   * otherwise look more spread out than the 5-team "All" view. Radius is
   * solved from the chord-length formula so it shrinks for smaller counts,
   * calibrated to the existing "All" look (radius = REFERENCE_RADIUS @ 5
   * items). CircularGallery corrects each card's perspective-driven size
   * back to what REFERENCE_RADIUS would produce, so a smaller radius here
   * only affects spacing, never the card's on-screen size. */
  const BASE_COUNT = 5
  const referenceGap = 2 * REFERENCE_RADIUS * Math.sin(Math.PI / BASE_COUNT)
  const galleryRadius =
    teams.length > 1 ? referenceGap / (2 * Math.sin(Math.PI / teams.length)) : REFERENCE_RADIUS

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
            {/* Reuses CircularGallery even for a single team (interactive=false, frozen at
             * rotation 0) — guarantees pixel-identical card sizing/perspective math against
             * All/Former, rather than approximating it with a separate static image. */}
            <CircularGallery
              items={galleryItems}
              radius={galleryRadius}
              autoRotateSpeed={0.035}
              interactive={!single}
              className={`h-[34rem] sm:h-[42rem] lg:h-[48rem] ${
                single ? '' : '-translate-y-12 sm:-translate-y-[4.5rem]'
              }`}
            />

            {!single && (
              <p className="ln-label absolute inset-x-0 bottom-0 text-center text-bone/35 sm:hidden">
                Swipe to rotate
              </p>
            )}
          </div>

          <div
            data-reveal
            className="relative -mt-8 overflow-hidden rounded-3xl border border-line bg-paper-deep/50 py-8 sm:-mt-12"
          >
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
