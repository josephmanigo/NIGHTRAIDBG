import { useReveal } from '../hooks/useReveal'

interface SectionHeaderProps {
  id?: string
  reveal?: boolean
  /** Bold condensed sans part of the headline. */
  title: string
  /** Serif italic accent appended to the headline (blood on dark, ink on light). */
  accent?: string
  kicker?: string
  tone?: 'light' | 'dark'
  align?: 'center' | 'left'
}

/** Editorial section header: oversized display heading mixing condensed sans
 *  with a serif italic accent word. */
export default function SectionHeader({
  id,
  reveal = true,
  title,
  accent,
  kicker,
  tone = 'light',
  align = 'center',
}: SectionHeaderProps) {
  const ref = useReveal<HTMLDivElement>({ selector: '[data-reveal]', stagger: 0.1 })
  const dark = tone === 'dark'
  const centered = align === 'center'

  return (
    <div
      ref={reveal ? ref : undefined}
      className={`relative mb-12 sm:mb-16 ${centered ? 'mx-auto max-w-4xl text-center' : ''}`}
    >
      <h2
        id={id}
        data-reveal={reveal ? '' : undefined}
        className={`text-[clamp(2.6rem,6.5vw,5.5rem)] uppercase leading-[0.9] ${
          dark ? 'text-bone' : 'text-ink'
        }`}
      >
        <span className="font-display">{title}</span>
        {accent && (
          <>
            {' '}
            <span className="ln-serif text-blood">{accent}</span>
          </>
        )}
      </h2>
      {kicker && (
        <p
          data-reveal={reveal ? '' : undefined}
          className={`mt-5 text-sm leading-relaxed sm:text-base ${
            dark ? 'text-bone/60' : 'text-ink/60'
          } ${centered ? 'mx-auto max-w-2xl' : 'max-w-xl'}`}
        >
          {kicker}
        </p>
      )}
    </div>
  )
}
