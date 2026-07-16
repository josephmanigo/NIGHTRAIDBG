/**
 * Competitive roster data — transcribed from the official NIGHTRAID
 * roster graphics in /public/images (Blood Strike Masters SEA and
 * Bloodstrike Arena Philippines Season 2 lineups).
 */

export type Division = 'PC' | 'Mobile' | 'Mixed'

export interface Player {
  tag: string
  role: string
}

export type TeamStatus = 'current' | 'former'

export interface Team {
  id: string
  name: string
  game: string
  division: Division
  /** 'current' = active competitive lineup, 'former' = past roster. */
  status: TeamStatus
  image: string
  imageAlt: string
  /** Landscape alternate lineup graphic, when one exists */
  altImage?: string
  players: Player[]
  headline: string
  note: string
}

export const TEAMS: Team[] = [
  {
    id: 'abyss',
    name: 'ABYSS',
    game: 'Blood Strike',
    division: 'PC',
    status: 'former',
    image: '/images/roster-abyss.png',
    imageAlt: 'NIGHTRAID Abyss lineup at the Blood Strike Masters SEA tournament',
    altImage: '/images/team-adyoo.png',
    players: [
      { tag: 'EGO', role: 'Entry / IGL' }, // [PLACEHOLDER] roles pending confirmation
      { tag: 'JAZU', role: 'Rifler' },
      { tag: 'DARCY', role: 'Flex' },
      { tag: 'T4CE', role: 'Support' },
    ],
    headline: 'BSM SEA · Top 6',
    note: 'Qualified through the BSM Wildcard Philippines and closed Blood Strike Masters SEA inside the top six on PC.',
  },
  {
    id: 'deso',
    name: 'DESO',
    game: 'Blood Strike',
    division: 'PC',
    status: 'former',
    image: '/images/roster-deso.png',
    imageAlt: 'NIGHTRAID Deso lineup at the Blood Strike Masters SEA tournament',
    altImage: '/images/team-deso.png',
    players: [
      { tag: 'ZUKI', role: 'Masters SEA lineup' },
      { tag: 'WHIMSYYY', role: 'Masters SEA lineup' },
      { tag: 'SCALP', role: 'Masters SEA lineup' },
      { tag: 'TAKUMI', role: 'Masters SEA lineup' },
    ],
    headline: 'Scrimmage circuit champions',
    note: 'Back-to-back SG Esports PH PC Scrimmage champions and Bloodstrike Arena Philippines Season 2 grand finalists.',
  },
  {
    id: 'mantas',
    name: 'MANTAS',
    game: 'Blood Strike',
    division: 'PC',
    status: 'former',
    image: '/images/roster-mantas.png',
    imageAlt: 'NIGHTRAID Mantas lineup at the Blood Strike Masters SEA tournament',
    players: [
      { tag: 'WAYNE', role: 'PC squad' },
      { tag: 'SOLO', role: 'PC squad' },
      { tag: 'STAB', role: 'PC squad' },
      { tag: 'VANCE', role: 'PC squad' },
      { tag: 'HARL', role: 'PC squad' },
      { tag: 'PEW', role: 'PC squad' },
    ],
    headline: 'BSM SEA · Top 11',
    note: 'Took the BSM Wildcard Philippines route and finished top eleven at Blood Strike Masters SEA on PC.',
  },
  {
    id: 'starks',
    name: 'STARKS',
    game: 'Blood Strike',
    division: 'Mobile',
    status: 'former',
    image: '/images/roster-starks.png',
    imageAlt: 'NIGHTRAID Starks lineup at the Blood Strike Masters SEA tournament',
    players: [
      { tag: 'KAZU', role: 'Mobile squad' },
      { tag: 'PILZEN', role: 'Mobile squad' },
      { tag: 'SCOLD', role: 'Mobile squad' },
      { tag: 'SEBB', role: 'Mobile squad' },
      { tag: 'SAGBA', role: 'Mobile squad' },
    ],
    headline: 'BSM SEA · Top 2',
    note: 'Invited to BSM Philippines, then finished second across all of Blood Strike Masters SEA on mobile.',
  },
  {
    id: 'shadow',
    name: 'SHADOW',
    game: 'Blood Strike',
    division: 'PC',
    status: 'current',
    image: '/images/roster-shadow.png',
    imageAlt: 'NIGHTRAID Shadow lineup at the Blood Strike Masters Asia S2 tournament',
    players: [
      { tag: 'YUNO', role: 'Masters Asia S2 lineup' },
      { tag: 'HARL', role: 'Masters Asia S2 lineup' },
      { tag: 'AMARI', role: 'Masters Asia S2 lineup' },
      { tag: 'KODAKBLU', role: 'Masters Asia S2 lineup' },
    ],
    headline: 'BSM Asia S2 Lineup',
    note: 'Competing in the Blood Strike Masters Asia Season 2 tournament as the official NIGHTRAID Shadow squad.',
  },
  {
    id: 'modern',
    name: 'MODERN',
    game: 'Blood Strike',
    division: 'PC',
    status: 'former',
    image: '/images/roster-modern.png',
    imageAlt: 'NIGHTRAID Modern lineup at the Blood Strike Masters Asia S2 tournament',
    players: [
      { tag: 'GLHEP', role: 'Masters Asia S2 lineup' },
      { tag: 'FIGSU', role: 'Masters Asia S2 lineup' },
      { tag: 'ZERI', role: 'Masters Asia S2 lineup' },
      { tag: 'UZI', role: 'Masters Asia S2 lineup' },
    ],
    headline: 'BSM Asia S2 Lineup',
    note: 'Competing in the Blood Strike Masters Asia Season 2 tournament as the official NIGHTRAID Modern squad.',
  },
]

export const DIVISION_FILTERS = ['All', 'PC', 'Mobile'] as const
export type DivisionFilter = (typeof DIVISION_FILTERS)[number]

export const TEAM_STATUS_FILTERS = ['All', 'Current', 'Former'] as const
export type TeamStatusFilter = (typeof TEAM_STATUS_FILTERS)[number]

/** Full community roster — transcribed from the official members list graphic. */
export const COMMUNITY_IMAGE = '/images/nightraid-members.png'
export const COMMUNITY_MEMBERS = [
  'Aeprilyn', 'Agony', 'Ansen', 'Asser', 'Berii', 'Breezy', 'Cael', 'Cumsht',
  'Darcy', 'Drie', 'Ego', 'Elijah', 'France', 'Geenie', 'Gian', 'Grim',
  'Haori', 'Hanni', 'Hans', 'Harl', 'Haru', 'Hexx', 'Iggy?', 'Ikarii',
  'Izuu', 'Jazu', 'Juls', 'Jynx', 'Karina', 'Kazuya', 'Kazuyaa', 'Kei',
  'Kenneth', 'Kimu', 'Kira', 'Kotox', 'Leejoyn', 'Lesyuex', 'Lopex', 'Lucisaur',
  'Madmax', 'Makarov', 'Maloi', 'Mamita', 'Matyu', 'Maxii', 'Mhot', 'M1mar',
  'Minji', 'Mushy', 'Nasjo', 'Nix', 'Noki', 'Nox', 'Paste', 'Quintix',
  'Reaper', 'Rinaa', 'Sais', 'Seb', 'Shan', 'Shura', 'Siopao', 'Slark',
  'Sofii', 'Stain', 'Sumiya', 'Sweetz', 'Tenji', 'Tisay', 'Wayne', 'Gomdi',
  'Xoisage', 'Yepo', 'Yoda', 'Yours', 'Yuno', 'Zef', 'Zenn', 'Zera',
  'Zhara', 'Zinaa', 'Zizi', 'Zyn', 'Storm', 'Chyy', 'Lijah', 'Skadi',
  'ZnealTzy', 'Conan', 'Mikasa', 'Ron', 'ARISE_IGRIS', 'Dominadora', 'Khalid', 'Ken',
  'Tokskieee', 'Cxxy.', 'LOYDIEE'
] as const
