interface MarqueeProps {
  text: string
  className?: string
  /** repeat count for one half of the loop */
  repeat?: number
}

/** Infinite text marquee (duplicated content, CSS keyframe translate).
 *  Purely decorative — hidden from assistive tech. */
export default function Marquee({ text, className = '', repeat = 6 }: MarqueeProps) {
  const items = Array.from({ length: repeat }, (_, i) => (
    <span key={i} className="mx-6 inline-block">
      {text}
      <span className="mx-6 inline-block text-blood-deep">✦</span>
    </span>
  ))
  return (
    <div aria-hidden="true" className={`pointer-events-none overflow-hidden whitespace-nowrap ${className}`}>
      <div className="animate-nr-marquee inline-block motion-reduce:animate-none">
        <span>{items}</span>
        <span>{items}</span>
      </div>
    </div>
  )
}
