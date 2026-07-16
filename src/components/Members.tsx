import { useMemo } from 'react'
import { TEAMS, COMMUNITY_MEMBERS } from '../data/teams'
import { CircularGallery, type GalleryItem } from './ui/circular-gallery'
import SectionHeader from './SectionHeader'
import Marquee from './Marquee'
import { useReveal } from '../hooks/useReveal'

export default function Members() {
  const ref = useReveal<HTMLDivElement>({ selector: '[data-reveal]', stagger: 0.15 })
  const teams = useMemo(() => TEAMS.filter((team) => team.id !== 'deso'), [])
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

  return (
    <section id="members" aria-label="NIGHTRAID members" className="relative overflow-hidden">
      <div className="mx-auto w-full max-w-[110rem] px-5 py-24 sm:px-8 sm:py-32 lg:px-12">
        <SectionHeader
          title="The"
          accent="raiders"
          kicker="These are NIGHTRAID’s competitive players."
        />

        <div ref={ref}>
          <div data-reveal className="relative -mx-5 sm:-mx-8 lg:-mx-12">
            <CircularGallery
              items={galleryItems}
              radius={350}
              autoRotateSpeed={0.035}
              className="h-[34rem] -translate-y-12 sm:h-[42rem] sm:-translate-y-[4.5rem] lg:h-[48rem]"
            />

            <p className="ln-label absolute inset-x-0 bottom-0 text-center text-bone/35 sm:hidden">
              Swipe to rotate
            </p>
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
