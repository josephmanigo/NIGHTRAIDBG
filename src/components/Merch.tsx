import { useState, useEffect } from 'react'
import { PRODUCTS, type Product } from '../data/products'
import SectionHeader from './SectionHeader'
import Carousel, { CarouselSlide } from './Carousel'
import { motion } from 'motion/react'
import TextRoll from './ui/TextRoll'
import { useReveal } from '../hooks/useReveal'

export default function Merch() {
  const revealRef = useReveal<HTMLDivElement>({ selector: '[data-reveal]', stagger: 0.15 })
  const [productId, setProductId] = useState<string>(PRODUCTS[0].id)
  const [slide, setSlide] = useState(0)
  const [size, setSize] = useState<string | null>(PRODUCTS[0].sizes?.[2] ?? null)
  const [startIndex, setStartIndex] = useState(0)

  const product: Product = PRODUCTS.find((p) => p.id === productId) ?? PRODUCTS[0]
  const index = Math.min(slide, product.images.length - 1)

  const selectedIndex = PRODUCTS.findIndex((p) => p.id === productId)
  useEffect(() => {
    if (selectedIndex !== -1) {
      setStartIndex((prev) => {
        if (selectedIndex < prev) {
          return selectedIndex
        } else if (selectedIndex >= prev + 8) {
          return selectedIndex - 7
        }
        return prev
      })
    }
  }, [selectedIndex])

  const selectProduct = (next: Product) => {
    setProductId(next.id)
    setSlide(0)
    // Preserve the chosen size when the next product offers it; otherwise reset.
    setSize((prev) => (prev && next.sizes?.includes(prev) ? prev : (next.sizes?.[2] ?? next.sizes?.[0] ?? null)))
  }

  return (
    <section id="merch" aria-labelledby="merch-title" className="relative">
      <div className="mx-auto w-full max-w-[110rem] px-5 py-24 sm:px-8 sm:py-32 lg:px-12">
        <SectionHeader
          title="Wear the"
          accent="raid"
          kicker="The same colors the squads wear on stage — jerseys, gear and the collector box, made per batch for the community."
        />

        <div ref={revealRef}>
        <div className="grid gap-10 lg:grid-cols-12 lg:gap-12">
          {/* Product image carousel */}
          <div data-reveal className="lg:col-span-7">
            <Carousel
              count={product.images.length}
              index={index}
              onIndexChange={setSlide}
              label={`${product.name} product images`}
              announcement={`${product.name}: image ${index + 1} of ${product.images.length}`}
              footerExtra={
                /* Thumbnails */
                product.images.length > 1 ? (
                  <div className="flex flex-wrap gap-2" role="group" aria-label={`${product.name} thumbnails`}>
                    {product.images.map((img, i) => (
                      <button
                        key={img.src}
                        type="button"
                        onClick={() => setSlide(i)}
                        aria-label={`Show image ${i + 1}`}
                        aria-current={i === index}
                        className={`h-12 w-12 overflow-hidden rounded-xl border transition-colors duration-300 sm:h-14 sm:w-14 ${
                          i === index ? 'border-ink' : 'border-line opacity-60 hover:opacity-100'
                        }`}
                      >
                        <img src={img.src} alt="" loading="lazy" className="h-full w-full object-cover" />
                      </button>
                    ))}
                  </div>
                ) : (
                  <span className="ln-label hidden text-ink/45 sm:block">{product.category}</span>
                )
              }
            >
              {product.images.map((img, i) => (
                <CarouselSlide key={img.src} active={i === index} className="w-full">
                  <div className="relative block w-full overflow-hidden rounded-2xl border border-line bg-paper-deep">
                    <img
                      src={img.src}
                      alt={img.alt}
                      loading={i === 0 ? 'eager' : 'lazy'}
                      width={2480}
                      height={2480}
                      className={`aspect-square w-full ${
                        img.fit === 'contain' ? 'object-contain' : 'object-cover'
                      }`}
                    />
                  </div>
                </CarouselSlide>
              ))}
            </Carousel>
          </div>

          {/* Product info */}
          <div data-reveal className="flex flex-col lg:col-span-5">
            <p className="ln-label text-ink/50">{product.category}</p>
            <h3 className="mt-3 font-display text-[clamp(2.4rem,5vw,4rem)] uppercase leading-[0.92] text-ink">
              {product.name}
            </h3>
            <p className="ln-serif mt-3 text-xl text-ink/70">{product.tagline}</p>

            <div className="mt-6 flex items-baseline gap-4 border-y border-line py-4">
              <span className="font-display text-3xl uppercase text-ink">
                {product.price ?? 'DM for price'}
              </span>
              <span className="ln-label text-ink/50">{product.availability}</span>
            </div>

            <p className="mt-6 text-sm leading-relaxed text-ink/60">{product.description}</p>

            {product.sizes && (
              <div className="mt-8">
                <p className="ln-label mb-3 text-ink/50">Size</p>
                <div role="radiogroup" aria-label={`${product.name} size`} className="flex flex-wrap gap-2">
                  {product.sizes.map((s) => (
                    <button
                      key={s}
                      role="radio"
                      aria-checked={size === s}
                      onClick={() => setSize(s)}
                      className={`h-11 min-w-11 rounded-full border px-4 font-body text-xs font-bold uppercase tracking-[0.1em] transition-colors duration-300 ${
                        size === s
                          ? 'border-ink bg-ink text-paper'
                          : 'border-ink/20 text-ink/55 hover:border-ink/60 hover:text-ink'
                      }`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-10 flex flex-wrap items-center gap-4">
              {/* [PLACEHOLDER] orderUrl is the future commerce integration point */}
              <motion.a
                href={product.orderUrl}
                data-magnetic
                className="ln-pill overflow-hidden flex items-center justify-center gap-1.5"
                initial="initial"
                whileHover="hovered"
              >
                <TextRoll>Order through the club</TextRoll>
                <span aria-hidden="true">→</span>
              </motion.a>
              <span className="ln-label text-[0.58rem] text-ink/40">
                Orders run via community DMs for now
              </span>
            </div>
          </div>
        </div>

        {/* Product switcher */}
        <div data-reveal className="mt-16">
          <div className="flex justify-between items-center mb-4">
            <p className="ln-label text-ink/50">The rack — {PRODUCTS.length} items</p>
            {PRODUCTS.length > 8 && (
              <div className="flex gap-2">
                <button
                  type="button"
                  className="ln-ctrl h-9 w-9 text-xs"
                  onClick={() => setStartIndex((prev) => Math.max(0, prev - 1))}
                  disabled={startIndex === 0}
                  aria-label="Previous products"
                >
                  ←
                </button>
                <button
                  type="button"
                  className="ln-ctrl h-9 w-9 text-xs"
                  onClick={() => setStartIndex((prev) => Math.min(PRODUCTS.length - 8, prev + 1))}
                  disabled={startIndex + 8 >= PRODUCTS.length}
                  aria-label="Next products"
                >
                  →
                </button>
              </div>
            )}
          </div>
          <div className="no-scrollbar -mx-5 flex gap-3 overflow-x-auto px-5 pb-2 sm:-mx-8 sm:px-8 lg:mx-0 lg:grid lg:grid-cols-8 lg:px-0">
            {PRODUCTS.slice(startIndex, startIndex + 8).map((p) => {
              const activeCard = p.id === product.id
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => selectProduct(p)}
                  aria-pressed={activeCard}
                  className={`w-32 shrink-0 overflow-hidden rounded-2xl border text-left transition-colors duration-300 lg:w-auto ${
                    activeCard ? 'border-ink bg-paper-deep' : 'border-line bg-paper hover:border-ink/45'
                  }`}
                >
                  <img src={p.images[0].src} alt="" loading="lazy" className="aspect-square w-full object-cover" />
                  <span className="block px-2.5 py-2.5">
                    <span className="block font-display text-sm uppercase leading-tight text-ink">
                      {p.name}
                    </span>
                    <span className="ln-label mt-1 block text-[0.5rem] text-ink/45">{p.category}</span>
                  </span>
                </button>
              )
            })}
          </div>
        </div>
        </div>
      </div>
    </section>
  )
}
