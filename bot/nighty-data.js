export const NIGHTY_STARTING_BALANCE = 1_000_000
export const NIGHTY_HUNT_COOLDOWN_SECONDS = 15
export const NIGHTY_BATTLE_COOLDOWN_SECONDS = 30
export const NIGHTY_PVP_EXPIRY_SECONDS = 120
export const NIGHTY_TRADE_EXPIRY_SECONDS = 600
export const NIGHTY_TIME_ZONE = process.env.NIGHTY_TIME_ZONE?.trim() || 'Asia/Manila'

export const NIGHTY_DAILY_REWARDS = Object.freeze([
  25_000,
  50_000,
  75_000,
  100_000,
  150_000,
  200_000,
  250_000,
])

export const NIGHTY_CHARACTERS = Object.freeze([
  { id: 'night_scout', name: 'Night Scout', rarity: 'Common', weight: 18, reward: 12_500, power: 100 },
  { id: 'raid_recruit', name: 'Raid Recruit', rarity: 'Common', weight: 18, reward: 15_000, power: 110 },
  { id: 'dusk_runner', name: 'Dusk Runner', rarity: 'Common', weight: 18, reward: 17_500, power: 120 },
  { id: 'shadow_medic', name: 'Shadow Medic', rarity: 'Rare', weight: 10, reward: 25_000, power: 155 },
  { id: 'moon_sniper', name: 'Moon Sniper', rarity: 'Rare', weight: 10, reward: 30_000, power: 170 },
  { id: 'neon_hacker', name: 'Neon Hacker', rarity: 'Rare', weight: 10, reward: 35_000, power: 185 },
  { id: 'raid_guardian', name: 'Raid Guardian', rarity: 'Epic', weight: 5, reward: 60_000, power: 240 },
  { id: 'abyss_duelist', name: 'Abyss Duelist', rarity: 'Epic', weight: 5, reward: 75_000, power: 265 },
  { id: 'night_commander', name: 'Night Commander', rarity: 'Legendary', weight: 2.5, reward: 150_000, power: 340 },
  { id: 'eclipse_reaper', name: 'Eclipse Reaper', rarity: 'Legendary', weight: 2.5, reward: 200_000, power: 380 },
  { id: 'night_sovereign', name: 'Night Sovereign', rarity: 'Mythic', weight: 1, reward: 500_000, power: 500 },
])

export const NIGHTY_CHARACTER_BY_ID = new Map(
  NIGHTY_CHARACTERS.map((character) => [character.id, character]),
)

export const NIGHTY_PVE_ENEMIES = Object.freeze([
  { id: 'neon_marauder', name: 'Neon Marauder', rank: 'Scout Threat', weight: 50, power: 90, reward: 50_000 },
  { id: 'shadow_beast', name: 'Shadow Beast', rank: 'Raid Threat', weight: 30, power: 145, reward: 100_000 },
  { id: 'abyss_warden', name: 'Abyss Warden', rank: 'Elite Threat', weight: 15, power: 220, reward: 250_000 },
  { id: 'eclipse_tyrant', name: 'Eclipse Tyrant', rank: 'Boss Threat', weight: 5, power: 350, reward: 500_000 },
])

export const NIGHTY_MISSIONS = Object.freeze([
  {
    id: 'daily_claim',
    periodType: 'daily',
    title: 'Midnight Allowance',
    description: 'Claim your Nighty daily reward.',
    event: 'daily_claim',
    goal: 1,
    reward: 50_000,
  },
  {
    id: 'daily_hunts',
    periodType: 'daily',
    title: 'Night Patrol',
    description: 'Complete 3 hunts.',
    event: 'hunt',
    goal: 3,
    reward: 75_000,
  },
  {
    id: 'daily_captures',
    periodType: 'daily',
    title: 'Recruitment Run',
    description: 'Capture 2 NIGHTRAID characters.',
    event: 'capture',
    goal: 2,
    reward: 100_000,
  },
  {
    id: 'daily_games',
    periodType: 'daily',
    title: 'Arcade Patrol',
    description: 'Complete 3 Nighty games.',
    event: 'game_played',
    goal: 3,
    reward: 125_000,
  },
  {
    id: 'weekly_hunts',
    periodType: 'weekly',
    title: 'Seven-Night Patrol',
    description: 'Complete 25 hunts this week.',
    event: 'hunt',
    goal: 25,
    reward: 500_000,
  },
  {
    id: 'weekly_captures',
    periodType: 'weekly',
    title: 'Build the Raid',
    description: 'Capture 15 NIGHTRAID characters this week.',
    event: 'capture',
    goal: 15,
    reward: 750_000,
  },
  {
    id: 'weekly_currency',
    periodType: 'weekly',
    title: 'Night Fortune',
    description: 'Earn 500,000 Night Currency this week.',
    event: 'currency_earned',
    goal: 500_000,
    reward: 1_000_000,
  },
  {
    id: 'weekly_games',
    periodType: 'weekly',
    title: 'Nighty Game Master',
    description: 'Complete 20 Nighty games this week.',
    event: 'game_played',
    goal: 20,
    reward: 1_250_000,
  },
])

export const NIGHTY_MISSION_BY_ID = new Map(
  NIGHTY_MISSIONS.map((mission) => [mission.id, mission]),
)

export function formatNightCurrency(value) {
  const amount = Math.max(0, Math.trunc(Number(value) || 0))
  return `${new Intl.NumberFormat('en-US').format(amount)} Night Currency`
}

export function selectNightyCharacter(random = Math.random) {
  const roll = Math.min(99.999999, Math.max(0, Number(random()) * 100))
  let cursor = 0
  for (const character of NIGHTY_CHARACTERS) {
    cursor += character.weight
    if (roll < cursor) return character
  }
  return NIGHTY_CHARACTERS[NIGHTY_CHARACTERS.length - 1]
}

export function selectNightyEnemy(random = Math.random) {
  const roll = Math.min(99.999999, Math.max(0, Number(random()) * 100))
  let cursor = 0
  for (const enemy of NIGHTY_PVE_ENEMIES) {
    cursor += enemy.weight
    if (roll < cursor) return enemy
  }
  return NIGHTY_PVE_ENEMIES[NIGHTY_PVE_ENEMIES.length - 1]
}

export function resolveNightyBattle(character, random = Math.random) {
  const enemy = selectNightyEnemy(random)
  const playerRoll = character.power + Math.floor(Number(random()) * 101)
  const enemyRoll = enemy.power + Math.floor(Number(random()) * 101)
  return {
    character,
    enemy,
    playerRoll,
    enemyRoll,
    won: playerRoll >= enemyRoll,
  }
}

export function parseNightAmount(value) {
  const match = String(value || '').trim().toLowerCase().replace(/,/g, '').match(/^(\d+)([km])?$/)
  if (!match) return null
  const multiplier = match[2] === 'm' ? 1_000_000 : match[2] === 'k' ? 1_000 : 1
  const amount = Number(match[1]) * multiplier
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null
}

function zonedCalendarDate(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const values = Object.fromEntries(
    parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]),
  )
  return `${values.year}-${values.month}-${values.day}`
}

export function nightyPeriodKeys(date = new Date(), timeZone = NIGHTY_TIME_ZONE) {
  const dailyKey = zonedCalendarDate(date, timeZone)
  const [year, month, day] = dailyKey.split('-').map(Number)
  const calendar = new Date(Date.UTC(year, month - 1, day))
  const mondayOffset = (calendar.getUTCDay() + 6) % 7
  calendar.setUTCDate(calendar.getUTCDate() - mondayOffset)
  const weeklyKey = calendar.toISOString().slice(0, 10)
  return { dailyKey, weeklyKey }
}
