/**
 * Event data — transcribed from the official NIGHTRAID event posters
 * in /public/images. Dates are as printed on each poster.
 */

export interface EventPhoto {
  src: string
  alt: string
  caption: string
}

export interface RaidEvent {
  id: string
  title: string
  series: string
  /** ISO date used for Upcoming/Past bucketing (event start). */
  date: string
  dateLabel: string
  time?: string
  venue: string
  games: string[]
  prize: string
  scope: string
  details: string[]
  photos: EventPhoto[]
}

export const EVENTS: RaidEvent[] = [
  {
    id: 'second-anniversary',
    title: '2ND ANNIVERSARY',
    series: 'Two Year Anniversary Tournament',
    date: '2026-05-12',
    dateLabel: 'MAY 1–21, 2026',
    venue: 'Online · NIGHTRAID HQ',
    games: ['Blood Strike', 'Mobile Legends', 'Discord games'],
    prize: '₱25,000 total prize pool',
    scope: 'Open brackets + NIGHTRAID-only finals',
    details: [
      'Anniversary Kick-off — ₱4,500 · May 1',
      'Mobile Legends — ₱3,000 · May 12',
      'Squad Fight — ₱2,500 · May 13',
      'Bingo Night — ₱2,000 · May 14',
      'Blood Strike Solo — ₱1,500 · May 14',
      'Duckrace — ₱5,000 · May 15',
      'Blood Strike Duo — ₱2,000 · May 19',
      'Best of the Best Zero — ₱2,500 · May 20',
      'Discord Game — ₱2,000 · May 21',
    ],
    photos: [
      {
        src: '/images/2nd-anniv.png',
        alt: 'NIGHTRAID 2nd Anniversary poster detailing a ₱25,000 prize pool across multiple events',
        caption: 'Two years of NIGHTRAID — ₱25,000 across multiple gaming brackets in May.',
      },
    ],
  },
  {
    id: 'bleach-pass-giveaway',
    title: 'BLEACH PASS GIVEAWAY',
    series: 'Members-Only Giveaway',
    date: '2026-03-02',
    dateLabel: 'MARCH 2, 2026',
    venue: 'Discord · members only',
    games: ['Blood Strike'],
    prize: '3 Bleach Passes',
    scope: 'NIGHTRAID members only',
    details: [
      '3 lucky winners to receive a Bleach Pass',
      'Like the post to enter the draw',
      'Collab with Spike-Toshiro Hitsugaya',
    ],
    photos: [
      {
        src: '/images/giveaway.jpg',
        alt: 'NIGHTRAID Bleach Pass giveaway poster featuring Spike-Toshiro Hitsugaya collab',
        caption: 'Members-only Bleach Pass giveaway.',
      },
    ],
  },
  {
    id: 'bingo-night',
    title: 'BINGO NIGHT',
    series: 'Community Night',
    date: '2026-02-21',
    dateLabel: 'FEBRUARY 21, 2026 · 10:00 PM',
    venue: 'Online · NIGHTRAID HQ',
    games: ['Bingo'],
    prize: '₱1,000 prize pool',
    scope: 'All members',
    details: [
      'Nonstop fun with cash prizes',
      'Feel the thrill in every round',
    ],
    photos: [
      {
        src: '/images/bingo.jpg',
        alt: 'NIGHTRAID Bingo Night poster with a gold bingo cage and 1,000 pesos prize pool',
        caption: 'Community Bingo Night — 1,000 Pesos in prizes.',
      },
    ],
  },
  {
    id: 'night-grind',
    title: 'NIGHT GRIND',
    series: 'Season-Long Activity Event',
    date: '2025-09-01',
    dateLabel: 'SEASON 2025',
    venue: 'Online · all divisions',
    games: ['Blood Strike', 'Mobile Legends', 'Farlight 84'],
    prize: '₱5,000 cash + Redragon keyboard & mouse combo + NIGHTRAID tee w/ lanyard',
    scope: 'Be active. Earn points. Stay ahead. Win big.',
    details: [
      '₱5,000 cash prize',
      'NIGHTRAID tee with lanyard',
      'Redragon EISA K686 PRO SE keyboard + K1NG M916 PRO mouse combo (worth ₱5,800)',
    ],
    photos: [
      {
        src: '/images/event-5.png',
        alt: 'Night Grind 2025 poster with anime-themed Redragon keyboard and mouse prizes',
        caption: 'Grind points all season — hardware for the hungriest.',
      },
    ],
  },
  {
    id: 'maggie-tournament',
    title: 'BEST OF THE BEST',
    series: 'NIGHTRAID Battleground · Maggie Tournament',
    date: '2025-08-30',
    dateLabel: 'AUGUST 30, 2025',
    venue: 'Online · Farlight 84',
    games: ['Farlight 84'],
    prize: '₱2,000 · winner takes all',
    scope: '5 rounds · Maggie only',
    details: ['Match day: August 30 — five rounds', 'Winner takes all: ₱2,000'],
    photos: [
      {
        src: '/images/event-4.png',
        alt: 'Best of the Best Maggie Tournament poster in a neon arena',
        caption: 'One hero. Five rounds. Winner takes all.',
      },
    ],
  },
  {
    id: 'july-royale',
    title: 'JULY ROYALE',
    series: 'Solo Event',
    date: '2025-07-18',
    dateLabel: 'JULY 18 & 25, 2025',
    venue: 'Online · solo queue',
    games: ['Blood Strike', 'Farlight 84'],
    prize: '₱2,000 pool · ₱250 GCash per game',
    scope: 'Solo players only',
    details: [
      'Blood Strike night — July 18',
      'Farlight 84 night — July 25',
      '₱250 GCash paid out per game won',
    ],
    photos: [
      {
        src: '/images/event-3.png',
        alt: 'July Royale solo event poster with two armored characters back to back',
        caption: 'Solo bracket. No squad to carry you.',
      },
    ],
  },
  {
    id: '6-7-challenge',
    title: '6-7 CHALLENGE',
    series: 'Community Challenge',
    date: '2025-06-07',
    dateLabel: 'JUNE 7, 2025',
    venue: 'Online · members only',
    games: ['Blood Strike'],
    prize: '₱2,000 prize pool',
    scope: 'NIGHTRAID members only',
    details: [
      'Ranked Game (Mythic) challenge',
      'Requirement: Get exactly 6 kills and 7 assists in a ranked game (Mythic) with a victory to win',
      'Prizes: ₱200 GCash per winner (up to 10 winners)',
    ],
    photos: [
      {
        src: '/images/67.png',
        alt: '6-7 Challenge event poster with a 2,000 pesos prize pool',
        caption: '6-7 Challenge — get 6 kills, 7 assists and a win in Mythic Ranked to claim.',
      },
    ],
  },
  {
    id: 'triple-clash',
    title: 'TRIPLE CLASH',
    series: 'Members-Only June Circuit',
    date: '2025-06-06',
    dateLabel: 'JUNE 6 / 13 / 20, 2025',
    venue: 'Online · members only',
    games: ['Blood Strike', 'Mobile Legends', 'Farlight 84'],
    prize: '₱5,500 prize pool',
    scope: 'Weekly wins, all June',
    details: [
      'Hot Zone Trio — Blood Strike · ₱600 per round · June 6',
      'Mage Showdown — Mobile Legends · ₱1,500 · mage only · June 13',
      'Dual Threat — Farlight 84 · ₱500 per round · June 20',
    ],
    photos: [
      {
        src: '/images/event-2.png',
        alt: 'Triple Clash June circuit poster: Hot Zone Trio, Mage Showdown and Dual Threat',
        caption: 'Three games. Three Fridays. One ₱5,500 pot.',
      },
    ],
  },
  {
    id: 'best-of-the-best-zero',
    title: 'BEST OF THE BEST: ZERO',
    series: 'NIGHTRAID Battleground · Zero Tournament',
    date: '2025-05-31',
    dateLabel: 'MAY 31, 2025 · 6:00 PM',
    venue: 'Online · Blood Strike',
    games: ['Blood Strike'],
    prize: 'Community bragging rights',
    scope: 'Solo players · Zero only',
    details: [
      'Solo tournament to determine the ultimate Zero user',
      'Blood Strike character showcase event',
      'Open to all NIGHTRAID members',
    ],
    photos: [
      {
        src: '/images/zero.png',
        alt: 'Best of the Best Zero Tournament poster with character Zero holding dual pistols',
        caption: 'Who is the best Zero user? Character showcase event.',
      },
    ],
  },
  {
    id: 'night-of-fury',
    title: 'NIGHT OF FURY',
    series: 'One Year Anniversary Tournament',
    date: '2025-05-12',
    dateLabel: 'MAY 12–15, 2025',
    venue: 'Online · NIGHTRAID HQ',
    games: ['Blood Strike', 'Farlight 84'],
    prize: '₱30,000 total prize pool',
    scope: 'Open brackets + NIGHTRAID-only finals',
    details: [
      'Blood Strike tournament — ₱5,000 · May 12',
      'Farlight 84 tournament — ₱5,000 · May 13',
      'NIGHTRAID-only bracket — ₱20,000 · May 14–15',
      'Sponsored by Mamitalove & Ego',
    ],
    photos: [
      {
        src: '/images/event-7.png',
        alt: 'Night of Fury one-year anniversary poster with a ₱30,000 prize pool',
        caption: 'One year of NIGHTRAID — ₱30,000 across three brackets.',
      },
    ],
  },
  {
    id: 'anniversary-kickoff',
    title: '5-12 ANNIVERSARY KICKOFF',
    series: 'Anniversary Special',
    date: '2025-05-12',
    dateLabel: 'MAY 12, 2025',
    venue: 'Online · members only',
    games: ['Blood Strike'],
    prize: '₱4,500 prize pool',
    scope: 'NIGHTRAID members only',
    details: [
      'Kickoff event for the NIGHTRAID Anniversary',
      'Requirement: Get exactly 5 kills and 12 assists with a victory to win',
      'Prizes: ₱500 for the 1st winner, ₱400 for the next 10 winners',
    ],
    photos: [
      {
        src: '/images/512.png',
        alt: '5-12 Anniversary Kickoff event poster with a 4,500 pesos prize pool',
        caption: 'Anniversary Kickoff — get 5 kills, 12 assists and a win to claim.',
      },
    ],
  },
  {
    id: 'slayer-streak',
    title: 'SLAYER & STREAK',
    series: 'Members-Only Kill Race',
    date: '2025-04-01',
    dateLabel: 'SEASON 2025',
    venue: 'Online · NIGHTRAID clan',
    games: ['Blood Strike'],
    prize: '₱7,500 prize pool',
    scope: 'Night members only',
    details: ['Every kill counts. Every streak matters.', 'Must be in the NIGHTRAID clan'],
    photos: [
      {
        src: '/images/event-6.png',
        alt: 'Slayer and Streak event poster with a ₱7,500 prize over red smoke',
        caption: 'Every kill counts. Every streak matters.',
      },
    ],
  },
  {
    id: 'birthday-event',
    title: 'NIGHTRAID BIRTHDAY',
    series: 'Community Party Games',
    date: '2025-03-16',
    dateLabel: 'MARCH 16, 2025 · 2:00 PM',
    venue: 'Online + Discord stage',
    games: ['Farlight 84', 'Blood Strike', 'Discord games'],
    prize: '₱4,000 prize pool',
    scope: 'Night members & friends only',
    details: [
      'Farlight 84 — 7 party modes · ₱300 per game',
      'Blood Strike — 5 party modes · ₱200 per game',
      'Discord games — duck race & guess-the-drawing · ₱900',
    ],
    photos: [
      {
        src: '/images/event-1.png',
        alt: 'NIGHTRAID birthday event program on red silk with the full game schedule',
        caption: 'The whole clan, one long birthday night.',
      },
    ],
  },
  {
    id: 'squad-fight',
    title: 'SQUAD FIGHT',
    series: 'Mini Event',
    date: '2024-11-22',
    dateLabel: 'NOVEMBER 22, 2024 · 9 PM', // [PLACEHOLDER] year assumed from poster
    venue: 'Online',
    games: ['Farlight 84'],
    prize: 'Community bragging rights',
    scope: 'Open squads',
    details: ['Squad-versus-squad mini event, November 22 at 9 PM.'],
    photos: [
      {
        src: '/images/event-8.png',
        alt: 'NIGHTRAID Squad Fight mini event poster under blue stage lights',
        caption: 'Where half the roster earned their tags.',
      },
    ],
  },
]

export const EVENT_FILTERS = ['All', 'Upcoming', 'Past'] as const
export type EventFilter = (typeof EVENT_FILTERS)[number]
