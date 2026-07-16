/**
 * Merch catalog — product names transcribed from the official NIGHTRAID
 * merch cards. Prices and stock are [PLACEHOLDER] integration points:
 * orders currently run through the NIGHTRAID Discord, so `orderUrl` points
 * there until a shop/checkout exists.
 */

export interface ProductImage {
  src: string
  alt: string
  /** contain = isolated product shot, cover = lifestyle/photo shot */
  fit: 'contain' | 'cover'
}

export interface Product {
  id: string
  name: string
  category: 'Apparel' | 'Accessories' | 'Bundle'
  tagline: string
  description: string
  price: string | null // [PLACEHOLDER] null renders "DM for price"
  sizes: string[] | null
  availability: string
  featured?: boolean
  images: ProductImage[]
  orderUrl: string // [PLACEHOLDER] integration point for future commerce
}

export const PRODUCTS: Product[] = [
  {
    id: 'jersey-v2-2026',
    name: 'NIGHTRAID JERSEY V2 (2026)',
    category: 'Apparel',
    tagline: 'The next generation team kit.',
    description:
      'The official NIGHTRAID Jersey V2 for the 2026 season. Features high-density flame accents, customized sleeve trim, and sublimated crest branding. Available in both Crimson Red and Sakura Pink colorways with custom nameprinting options.',
    price: null,
    sizes: ['S', 'M', 'L', 'XL', '2XL', '3XL'],
    availability: 'Pre-order — customized per order',
    featured: true,
    images: [
      { src: '/images/newjersey.jpg', alt: 'NIGHTRAID Jersey V2 2026 — Crimson Red and Sakura Pink colorway previews', fit: 'contain' },
      { src: '/images/newjerseyred.jpg', alt: 'NIGHTRAID Jersey V2 2026 Crimson Red — front and back details', fit: 'contain' },
      { src: '/images/newjerseypink.jpg', alt: 'NIGHTRAID Jersey V2 2026 Sakura Pink — front and back details', fit: 'contain' },
    ],
    orderUrl: 'https://discord.gg/8DD8HHhUTH',
  },
  {
    id: 'compe-jersey',
    name: 'COMPE JERSEY',
    category: 'Apparel',
    tagline: 'The kit the squads wear on stage.',
    description:
      'Zip-collar competitive jersey in NIGHTRAID black and red — flame print, crest on the chest, NIGHTRAID wordmark down the side seam. Worn by every roster from Arena PH to Blood Strike Masters SEA.',
    price: null,
    sizes: ['S', 'M', 'L', 'XL', '2XL', '3XL'], // [PLACEHOLDER] size run
    availability: 'Made per batch — order through the club',
    featured: true,
    images: [
      { src: '/images/merch-4.png', alt: 'NIGHTRAID compe jersey — front view on dark stage', fit: 'contain' },
      { src: '/images/merch-9.png', alt: 'NIGHTRAID competitive player jersey — alternate colorway view', fit: 'contain' },
    ],
    orderUrl: 'https://discord.gg/8DD8HHhUTH',
  },
  {
    id: 'casual-jersey',
    name: 'CASUAL JERSEY',
    category: 'Apparel',
    tagline: 'Team colors, street cut.',
    description:
      'V-neck casual jersey with the same flame identity as the compe kit, cut for daily wear. Crest embroidery and NIGHTRAID collar tape.',
    price: null,
    sizes: ['S', 'M', 'L', 'XL', '2XL'], // [PLACEHOLDER] size run
    availability: 'Made per batch — order through the club',
    images: [
      { src: '/images/merch-8.png', alt: 'NIGHTRAID casual jersey — V-neck front view', fit: 'contain' },
    ],
    orderUrl: 'https://discord.gg/8DD8HHhUTH',
  },
  {
    id: 'premium-tee',
    name: 'PREMIUM TEE',
    category: 'Apparel',
    tagline: 'Oversized cut, full raid graphic on the back.',
    description:
      'Heavyweight oversized tee in NIGHTRAID black — small wordmark hit on the chest, full "Raid the Night, Rule the Game" back graphic with the crest lockup. Streetwear cut for everyday wear off the server.',
    price: null,
    sizes: ['S', 'M', 'L', 'XL', '2XL', '3XL'], // [PLACEHOLDER] size run
    availability: 'Made per batch — order through the club',
    images: [
      { src: '/images/premium-tee-model.png', alt: 'NIGHTRAID premium tee worn on-model — chest wordmark hit and full back "Raid the Night, Rule the Game" graphic', fit: 'cover' },
    ],
    orderUrl: 'https://discord.gg/8DD8HHhUTH',
  },
  {
    id: 'tumbler',
    name: 'RAID TUMBLER',
    category: 'Accessories',
    tagline: 'Raid the night. Hydrate the game.',
    description:
      'Matte red insulated tumbler with the "Raid the Night, Rule the Game!" graffiti print and crest detail. Keeps the grind fueled through scrim blocks.',
    price: null,
    sizes: null,
    availability: 'In stock at community events',
    images: [
      { src: '/images/merch-3.png', alt: 'Four NIGHTRAID red tumblers with slogan print', fit: 'contain' },
    ],
    orderUrl: 'https://discord.gg/8DD8HHhUTH',
  },
  {
    id: 'mousepad',
    name: 'NIGHT MOUSEPAD',
    category: 'Accessories',
    tagline: 'Cherry-blossom nights, frag-ready surface.',
    description:
      'Extended cloth pad with the NIGHTRAID wordmark and blossom artwork. Low-friction weave tuned for FPS flicks.',
    price: null,
    sizes: null,
    availability: 'Limited run',
    images: [
      { src: '/images/merch-1.png', alt: 'NIGHTRAID mousepad on a desk with mouse and keyboard', fit: 'cover' },
    ],
    orderUrl: 'https://discord.gg/8DD8HHhUTH',
  },
  {
    id: 'lanyard',
    name: 'NIGHTRAID LANYARD',
    category: 'Accessories',
    tagline: 'Colors you can wear to every lan.',
    description:
      'Woven lanyard in flame red and black with the NIGHTRAID wordmark, detachable clip and key ring.',
    price: null,
    sizes: null,
    availability: 'In stock at community events',
    images: [
      { src: '/images/merch-5.png', alt: 'NIGHTRAID lanyards with red flame print worn around a neck', fit: 'cover' },
    ],
    orderUrl: 'https://discord.gg/8DD8HHhUTH',
  },
  {
    id: 'neck-pillow',
    name: 'NECK PILLOW',
    category: 'Accessories',
    tagline: 'For the long grinds between matches.',
    description:
      'Crimson velour neck pillow with crest embroidery — the unofficial MVP of every overnight scrim block. Name embroidery available per batch.',
    price: null,
    sizes: null,
    availability: 'Made per batch',
    images: [
      { src: '/images/merch-6.png', alt: 'Red NIGHTRAID neck pillow with crest embroidery', fit: 'contain' },
    ],
    orderUrl: 'https://discord.gg/8DD8HHhUTH',
  },
  {
    id: 'sticker-pack',
    name: 'STICKER PACK',
    category: 'Accessories',
    tagline: 'Tag your gear like you tag the lobby.',
    description:
      'Die-cut sticker pack — crest, "NIGHTRAID ON TOP", eat-sleep-raid and more. Laptop-safe vinyl.',
    price: null,
    sizes: null,
    availability: 'In stock',
    images: [
      { src: '/images/merch-7.png', alt: 'NIGHTRAID sticker pack in packaging with die-cut stickers', fit: 'cover' },
    ],
    orderUrl: 'https://discord.gg/8DD8HHhUTH',
  },
  {
    id: 'merch-box',
    name: 'NIGHTRAID MERCH BOX',
    category: 'Bundle',
    tagline: 'The full colors, one box.',
    description:
      'Collector bundle: compe jersey, embroidered cap, tumbler, lanyard and sticker pack in a crest-stamped box. Built for new signings and long-time members alike.',
    price: null,
    sizes: ['S', 'M', 'L', 'XL', '2XL'], // [PLACEHOLDER] jersey size in box
    availability: 'Limited — assembled per order',
    images: [
      { src: '/images/merch-2.png', alt: 'Open NIGHTRAID merch box with jersey, cap, tumbler and sticker pack', fit: 'cover' },
    ],
    orderUrl: 'https://discord.gg/8DD8HHhUTH',
  },
]
