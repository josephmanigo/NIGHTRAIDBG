/**
 * Global site data. Everything here is editable content.
 * Entries marked [PLACEHOLDER] are temporary and should be replaced
 * with real information when available.
 */

export interface NavItem {
  id: string
  label: string
  index: string
}

export const NAV_ITEMS: NavItem[] = [
  { id: 'home', label: 'Home', index: '01' },
  { id: 'about', label: 'About Us', index: '02' },
  { id: 'members', label: 'Members', index: '03' },
  { id: 'management', label: 'Management', index: '04' },
  { id: 'events', label: 'Events & Tournaments', index: '05' },
  { id: 'achievements', label: 'Achievements', index: '06' },
  { id: 'merch', label: 'Merch', index: '07' },
  { id: 'apply', label: 'Join NIGHTRAID', index: '08' },
]

export const SOCIAL_LINKS = [
  { label: 'Facebook', href: 'https://www.facebook.com/profile.php?id=61572305697774', handle: 'NIGHTRAID' },
  { label: 'Discord', href: 'https://discord.gg/8DD8HHhUTH', handle: 'NIGHTRAID HQ' },
  { label: 'TikTok', href: 'https://www.tiktok.com/@nightraidbg?is_from_webapp=1&sender_device=pc', handle: '@nightraidbg' },
] as const

export const ORG = {
  name: 'NIGHTRAID',
  tagline: 'Raid the Night. Rule the Game.',
  founded: '2024', // Night of Fury (May 2025) marked the one-year anniversary
  base: 'Philippines · SEA',
  games: ['Blood Strike', 'Mobile Legends: Bang Bang', 'Farlight 84'],
} as const

/** Animated counters in About. Derived from the official members list and
 *  achievement records shipped with the site data. */
export const STATS = [
  { value: 90, suffix: '+', label: 'Active Members' },
  { value: 42, suffix: '', label: 'Recorded Achievements' },
  { value: 17, suffix: '', label: 'Championship Titles' },
  { value: 3, suffix: '', label: 'Game Divisions' },
] as const
