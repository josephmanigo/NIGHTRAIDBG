import { useMemo, useState, MouseEvent } from 'react'
import { EVENTS, EVENT_FILTERS, type EventFilter, type RaidEvent } from '../data/events'
import { useReveal } from '../hooks/useReveal'
import SectionHeader from './SectionHeader'

function eventStatus(e: RaidEvent): 'UPCOMING' | 'PAST' {
  return new Date(e.date).getTime() > Date.now() ? 'UPCOMING' : 'PAST'
}

// Glowing pulsing target circle for upcoming events
const UpcomingIcon = () => (
  <span className="relative flex h-3 w-3 shrink-0">
    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blood opacity-75"></span>
    <span className="relative inline-flex rounded-full h-3 w-3 bg-blood"></span>
  </span>
)

// Subtle checkmark for past events
const PastIcon = () => (
  <svg className="w-4 h-4 stroke-current fill-none text-white/40 group-hover:text-white transition-colors duration-300 shrink-0" strokeWidth="2" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
  </svg>
)

const getStatusIcon = (status: 'UPCOMING' | 'PAST') => {
  return status === 'UPCOMING' ? <UpcomingIcon /> : <PastIcon />
}

/** Redesigned Events page matching the high-performance table design of the Achievements page. */
export default function Events() {
  const [filter, setFilter] = useState<EventFilter>('All')
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
  const [floatingTop, setFloatingTop] = useState<number>(0)
  const [activeImage, setActiveImage] = useState<string>('')
  const [activeAlt, setActiveAlt] = useState<string>('')
  const gridRef = useReveal<HTMLDivElement>({ selector: '[data-reveal]', stagger: 0.04 })

  const records = useMemo(() => {
    if (filter === 'All') return EVENTS
    return EVENTS.filter((e) => (filter === 'Upcoming' ? eventStatus(e) === 'UPCOMING' : eventStatus(e) === 'PAST'))
  }, [filter])

  const changeFilter = (f: EventFilter) => {
    setFilter(f)
    setHoveredIndex(null)
    setActiveImage('')
    setActiveAlt('')
  }

  const handleMouseEnter = (index: number, event: MouseEvent<HTMLDivElement>) => {
    setHoveredIndex(index)
    if (records[index] && records[index].photos?.[0]) {
      setActiveImage(records[index].photos[0].src)
      setActiveAlt(records[index].photos[0].alt || '')
    }
    const rowElement = event.currentTarget
    if (rowElement) {
      const top = rowElement.offsetTop + rowElement.offsetHeight / 2
      setFloatingTop(top)
    }
  }

  const handleMouseLeave = () => {
    setHoveredIndex(null)
  }

  return (
    <section id="events" aria-labelledby="events-title" data-theme="dark" className="relative overflow-hidden text-white">
      <div className="relative mx-auto w-full max-w-[110rem] px-5 py-24 sm:px-8 sm:py-32 lg:px-12">
        <SectionHeader
          title="Enter the"
          accent="arena"
          kicker="From ₱30,000 anniversary brackets to members-only kill races — the raid calendar never really closes."
          tone="dark"
        />

        {/* Filters */}
        <div data-reveal role="tablist" aria-label="Filter events" className="mb-14 flex flex-wrap justify-center items-center gap-4 text-xs font-bold uppercase tracking-wider text-white/50">
          {EVENT_FILTERS.map((f, idx) => (
            <span key={f} className="flex items-center gap-4">
              {idx > 0 && <span className="text-white/20 select-none">/</span>}
              <button
                role="tab"
                aria-selected={filter === f}
                onClick={() => changeFilter(f)}
                className={`hover:text-blood transition-colors duration-200 uppercase tracking-widest ${
                  filter === f ? 'text-blood font-extrabold' : 'text-white/60'
                }`}
              >
                {f === 'All' ? 'All Events' : `${f} Events`}
              </button>
            </span>
          ))}
        </div>

        <p aria-live="polite" className="sr-only">
          {records.length} events shown
        </p>

        {records.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-white/10 bg-[#0A0A0A] px-6 py-16 text-center">
            <p className="font-display text-3xl uppercase text-white">No raids on the board.</p>
            <p className="text-sm text-white/60 max-w-md">
              The next bracket drops on our community channels first — follow NIGHTRAID to catch it.
            </p>
          </div>
        ) : (
          /* Events table (stacked cards below lg, table rows on lg+) */
          <div className="w-full" ref={gridRef}>
            <div className="w-full">
              {/* Table Headers — desktop only */}
              <div className="hidden lg:grid grid-cols-12 gap-4 pb-4 border-b border-white/10 text-[0.65rem] font-bold uppercase tracking-[0.2em] text-white/40 px-4 mb-2">
                <div className="col-span-3 pl-4">Series</div>
                <div className="col-span-3">Name</div>
                <div className="col-span-2">When</div>
                <div className="col-span-2">Status</div>
                <div className="col-span-2 text-right pr-4">Prize</div>
              </div>

              {/* Table Rows */}
              <div className="space-y-1">
                {records.map((event, i) => {
                  const status = eventStatus(event)
                  return (
                    <div
                      key={event.id}
                      data-reveal
                      onMouseEnter={(e) => handleMouseEnter(i, e)}
                      onMouseLeave={handleMouseLeave}
                      className="border-b border-white/5 py-1.5 group relative"
                    >
                      {/* Entire Row Static Container — stacked card below lg, 12-col row on lg+ */}
                      <div
                        className="flex flex-col gap-2 rounded-lg py-4 px-4 bg-transparent transition-all duration-300 group-hover:bg-blood group-hover:text-white text-left w-full lg:grid lg:grid-cols-12 lg:items-center lg:gap-4"
                      >
                        {/* Column 1: Series */}
                        <span className="font-body text-xs font-semibold tracking-wider text-white/40 group-hover:text-white transition-colors duration-300 uppercase lg:col-span-3 lg:truncate lg:pl-2 lg:pr-4">
                          {event.series}
                        </span>

                        {/* Name (Tournament + Game Tags) */}
                        <span className="font-display text-2xl uppercase tracking-tight flex flex-col justify-center text-white transition-colors duration-300 lg:col-span-3 lg:pr-4">
                          <span className="lg:truncate">{event.title}</span>
                          <span className="font-body text-[0.6rem] font-bold tracking-wider text-white/45 group-hover:text-white/80 mt-1 uppercase">
                            {event.games.join(' / ')}
                          </span>
                        </span>

                        {/* When (Date) */}
                        <span className="font-body text-xs text-white/60 group-hover:text-white transition-colors duration-300 uppercase lg:col-span-2">
                          {event.dateLabel}
                        </span>

                        {/* Status + Prize — share one line below lg, separate grid cells on lg+ */}
                        <span className="flex items-center justify-between gap-4 lg:contents">
                          <span className="font-display text-xl uppercase tracking-tight flex items-center gap-2.5 text-white transition-colors duration-300 lg:col-span-2">
                            {getStatusIcon(status)}
                            <span>{status}</span>
                          </span>
                          <span className="font-display text-xl uppercase tracking-tight text-right text-white transition-colors duration-300 lg:col-span-2 lg:w-full lg:truncate lg:pr-2">
                            {event.prize}
                          </span>
                        </span>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        )}

        {/* Dynamic Floating Image Overlay outside of scroll container */}
        <div
          className={`absolute pointer-events-none z-50 w-[24rem] h-[28rem] lg:w-[28rem] lg:h-[32rem] transition-all duration-500 ease-cine hidden lg:block ${
            hoveredIndex !== null ? 'opacity-100 scale-100' : 'opacity-0 scale-95'
          }`}
          style={{
            top: `${floatingTop}px`,
            left: '60%',
            transform: 'translate(-50%, -50%)',
          }}
        >
          {activeImage && (
            <img
              src={activeImage}
              alt={activeAlt}
              className="w-full h-full object-contain"
            />
          )}
        </div>
      </div>
    </section>
  )
}
