/**
 * Leadership data — transcribed from the official NIGHTRAID management
 * graphics. Bios marked [PLACEHOLDER] are editable summaries, not quotes.
 */

export interface Leader {
  id: string
  name: string
  role: string
  tier: 'founder' | 'cofounder' | 'admin'
  bio: string
}

/** Founder quote, transcribed verbatim from the official founder graphic. */
export const FOUNDER_QUOTE =
  "The founder of Nightraid started this clan to create more than just a gaming team — a place where people can come together, have fun, and truly feel like they belong. It's never just about the wins; it's about late-night grinds, laughs with friends, and seeing everyone grow together. As founder, the goal is to keep that spirit alive, making sure everyone feels welcome and part of a community where friendships really matter."

export const MANAGEMENT_IMAGE = '/images/management-new.png'
export const MANAGEMENT_IMAGE_ALT =
  'NIGHTRAID management portrait — Prince, Kazuha, Powder, Ems, Mamitalove and Nasjo in crimson suits before the NIGHTRAID crest'

export const FOUNDER_IMAGE = '/images/emerald-founder-new.png'
export const FOUNDER_IMAGE_ALT =
  'Emerald, founder of NIGHTRAID, beside the founder manifesto on a crimson backdrop'

export const LEADERS: Leader[] = [
  {
    id: 'emerald',
    name: 'EMERALD',
    role: 'Founder',
    tier: 'founder',
    bio: 'Built NIGHTRAID from a late-night lobby into a multi-division esports community, and still leads it front-line first.',
  },
  {
    id: 'powder',
    name: 'POWDER',
    role: 'Co-Founder',
    tier: 'cofounder',
    bio: 'Runs the organization beside Emerald — operations, rosters and the standard every squad is held to.',
  },
  {
    id: 'tisay',
    name: 'TISAY',
    role: 'Admin',
    tier: 'admin',
    bio: 'Community operations and member onboarding.', // [PLACEHOLDER]
  },
  {
    id: 'kazuha',
    name: 'KAZUHA',
    role: 'Admin',
    tier: 'admin',
    bio: 'Scrim scheduling and squad coordination.', // [PLACEHOLDER]
  },
  {
    id: 'mamitalove',
    name: 'MAMITALOVE',
    role: 'Admin · Event Sponsor',
    tier: 'admin',
    bio: 'Community events — co-sponsored the ₱30,000 Night of Fury anniversary tournament.',
  },
  {
    id: 'prince',
    name: 'PRINCE',
    role: 'Admin',
    tier: 'admin',
    bio: 'Discord operations and community moderation.', // [PLACEHOLDER]
  },
  {
    id: 'nasjo',
    name: 'NASJO',
    role: 'Admin',
    tier: 'admin',
    bio: 'Match operations and tournament logistics.', // [PLACEHOLDER]
  },
  {
    id: 'mushy',
    name: 'MUSHY',
    role: 'Admin',
    tier: 'admin',
    bio: 'Recruitment and tryout pipelines.', // [PLACEHOLDER]
  },
  {
    id: 'ems',
    name: 'EMS',
    role: 'Admin',
    tier: 'admin',
    bio: 'Creative direction and official graphics.', // [PLACEHOLDER]
  },
]
