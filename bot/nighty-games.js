export const NIGHTY_MIN_BET = 1_000
export const NIGHTY_MAX_BET = 1_000_000
export const NIGHTY_FISHING_COOLDOWN_SECONDS = 20
export const NIGHTY_DUNGEON_COOLDOWN_SECONDS = 60
export const NIGHTY_BOSS_COOLDOWN_SECONDS = 120
export const NIGHTY_BLACKJACK_EXPIRY_SECONDS = 180
export const NIGHTY_TRIVIA_EXPIRY_SECONDS = 45
export const NIGHTY_WORD_EXPIRY_SECONDS = 90
export const NIGHTY_TRIVIA_REWARD = 100_000
export const NIGHTY_WORD_REWARD = 75_000

export const NIGHTY_SLOT_SYMBOLS = Object.freeze([
  { id: 'moon', label: '🌙', jackpotMultiplier: 12 },
  { id: 'crown', label: '👑', jackpotMultiplier: 10 },
  { id: 'crystal', label: '💎', jackpotMultiplier: 8 },
  { id: 'wolf', label: '🐺', jackpotMultiplier: 6 },
  { id: 'dagger', label: '🗡️', jackpotMultiplier: 5 },
  { id: 'star', label: '⭐', jackpotMultiplier: 4 },
])

export const NIGHTY_FISH = Object.freeze([
  { id: 'void_minnow', name: 'Void Minnow', rarity: 'Common', weight: 35, reward: 25_000 },
  { id: 'moon_koi', name: 'Moon Koi', rarity: 'Uncommon', weight: 30, reward: 40_000 },
  { id: 'neon_eel', name: 'Neon Eel', rarity: 'Rare', weight: 20, reward: 75_000 },
  { id: 'abyss_ray', name: 'Abyss Ray', rarity: 'Epic', weight: 10, reward: 150_000 },
  { id: 'eclipse_leviathan', name: 'Eclipse Leviathan', rarity: 'Legendary', weight: 5, reward: 500_000 },
])

export const NIGHTY_DUNGEONS = Object.freeze([
  { id: 'shattered_gate', name: 'The Shattered Gate', weight: 45, power: 80, reward: 80_000 },
  { id: 'neon_catacombs', name: 'Neon Catacombs', weight: 30, power: 155, reward: 175_000 },
  { id: 'abyss_archive', name: 'Abyss Archive', weight: 18, power: 250, reward: 350_000 },
  { id: 'eclipse_vault', name: 'Eclipse Vault', weight: 7, power: 375, reward: 750_000 },
])

export const NIGHTY_BOSSES = Object.freeze([
  { id: 'iron_wraith', name: 'Iron Wraith', weight: 50, power: 100, reward: 150_000 },
  { id: 'void_hydra', name: 'Void Hydra', weight: 30, power: 210, reward: 350_000 },
  { id: 'moon_devourer', name: 'Moon Devourer', weight: 15, power: 340, reward: 750_000 },
  { id: 'eternal_sovereign', name: 'Eternal Sovereign', weight: 5, power: 500, reward: 1_500_000 },
])

export const NIGHTY_TRIVIA_QUESTIONS = Object.freeze([
  {
    id: 'moon_orbit',
    question: 'About how long does the Moon take to orbit Earth?',
    choices: ['About 27 days', 'About 7 days', 'About 90 days', 'About 365 days'],
    correctIndex: 0,
  },
  {
    id: 'largest_planet',
    question: 'Which planet is the largest in our solar system?',
    choices: ['Mars', 'Saturn', 'Jupiter', 'Neptune'],
    correctIndex: 2,
  },
  {
    id: 'binary',
    question: 'Which two digits are used in binary?',
    choices: ['1 and 2', '0 and 1', '2 and 3', '0 and 9'],
    correctIndex: 1,
  },
  {
    id: 'speed_light',
    question: 'Light travels fastest through which of these?',
    choices: ['Water', 'Glass', 'A vacuum', 'Steel'],
    correctIndex: 2,
  },
  {
    id: 'chess_queen',
    question: 'In chess, which piece can move any number of squares in any direction?',
    choices: ['Queen', 'Knight', 'Pawn', 'King'],
    correctIndex: 0,
  },
  {
    id: 'pacific',
    question: 'Which is Earth’s largest ocean?',
    choices: ['Atlantic', 'Indian', 'Arctic', 'Pacific'],
    correctIndex: 3,
  },
])

export const NIGHTY_WORDS = Object.freeze([
  'shadow',
  'eclipse',
  'midnight',
  'guardian',
  'commander',
  'crystal',
  'fortress',
  'phantom',
  'starlight',
  'nightfall',
])

function boundedIndex(random, length) {
  return Math.min(length - 1, Math.max(0, Math.floor(Number(random()) * length)))
}

function weightedChoice(items, random) {
  const total = items.reduce((sum, item) => sum + item.weight, 0)
  const roll = Math.min(total - Number.EPSILON, Math.max(0, Number(random()) * total))
  let cursor = 0
  for (const item of items) {
    cursor += item.weight
    if (roll < cursor) return item
  }
  return items[items.length - 1]
}

export function validNightyBet(amount) {
  return Number.isSafeInteger(amount) && amount >= NIGHTY_MIN_BET && amount <= NIGHTY_MAX_BET
}

export function spinNightySlots(random = Math.random) {
  const symbols = Array.from({ length: 3 }, () => NIGHTY_SLOT_SYMBOLS[boundedIndex(random, NIGHTY_SLOT_SYMBOLS.length)])
  const counts = new Map()
  for (const symbol of symbols) counts.set(symbol.id, (counts.get(symbol.id) || 0) + 1)
  const triple = symbols.every((symbol) => symbol.id === symbols[0].id)
  const pair = Math.max(...counts.values()) === 2
  // A pair returns 1.5x while rarer triples use the symbol jackpot. This keeps
  // the overall slots return below 100% instead of continuously inflating the economy.
  const multiplier = triple ? symbols[0].jackpotMultiplier : pair ? 1.5 : 0
  return { symbols, multiplier, won: multiplier > 0 }
}

export function flipNightyCoin(choice, random = Math.random) {
  const result = Number(random()) < 0.5 ? 'heads' : 'tails'
  return { choice, result, won: choice === result, multiplier: choice === result ? 2 : 0 }
}

export function catchNightyFish(random = Math.random) {
  return weightedChoice(NIGHTY_FISH, random)
}

export function resolveNightyAdventure(character, encounters, random = Math.random) {
  const encounter = weightedChoice(encounters, random)
  const playerRoll = character.power + Math.floor(Number(random()) * 151)
  const enemyRoll = encounter.power + Math.floor(Number(random()) * 151)
  return {
    character,
    encounter,
    playerRoll,
    enemyRoll,
    won: playerRoll >= enemyRoll,
    reward: playerRoll >= enemyRoll ? encounter.reward : 0,
  }
}

export function selectNightyTrivia(random = Math.random) {
  return NIGHTY_TRIVIA_QUESTIONS[boundedIndex(random, NIGHTY_TRIVIA_QUESTIONS.length)]
}

export function createNightyWord(random = Math.random) {
  const answer = NIGHTY_WORDS[boundedIndex(random, NIGHTY_WORDS.length)]
  const letters = [...answer]
  for (let index = letters.length - 1; index > 0; index -= 1) {
    const target = boundedIndex(random, index + 1)
    ;[letters[index], letters[target]] = [letters[target], letters[index]]
  }
  let scrambled = letters.join('')
  if (scrambled === answer) scrambled = `${answer.slice(1)}${answer[0]}`
  return { answer, scrambled }
}

const CARD_SUITS = ['♠', '♥', '♦', '♣']
const CARD_RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']

export function blackjackHandValue(cards) {
  let value = 0
  let aces = 0
  for (const card of cards) {
    const rank = String(card).slice(0, -1)
    if (rank === 'A') {
      value += 11
      aces += 1
    } else if (['J', 'Q', 'K'].includes(rank)) value += 10
    else value += Number(rank)
  }
  while (value > 21 && aces > 0) {
    value -= 10
    aces -= 1
  }
  return value
}

export function createBlackjackState(random = Math.random) {
  const deck = CARD_SUITS.flatMap((suit) => CARD_RANKS.map((rank) => `${rank}${suit}`))
  for (let index = deck.length - 1; index > 0; index -= 1) {
    const target = boundedIndex(random, index + 1)
    ;[deck[index], deck[target]] = [deck[target], deck[index]]
  }
  const draw = () => deck.pop()
  return {
    deck,
    player: [draw(), draw()],
    dealer: [draw(), draw()],
  }
}

export function hitBlackjack(state) {
  return { ...state, deck: state.deck.slice(0, -1), player: [...state.player, state.deck[state.deck.length - 1]] }
}

export function finishBlackjack(state) {
  const next = { ...state, deck: [...state.deck], dealer: [...state.dealer], player: [...state.player] }
  while (blackjackHandValue(next.dealer) < 17 && next.deck.length > 0) next.dealer.push(next.deck.pop())
  const playerValue = blackjackHandValue(next.player)
  const dealerValue = blackjackHandValue(next.dealer)
  const natural = next.player.length === 2 && playerValue === 21
  let outcome = 'loss'
  let multiplier = 0
  if (playerValue > 21) outcome = 'bust'
  else if (dealerValue > 21 || playerValue > dealerValue) {
    outcome = natural ? 'blackjack' : 'win'
    multiplier = natural ? 2.5 : 2
  } else if (playerValue === dealerValue) {
    outcome = 'push'
    multiplier = 1
  }
  return { state: next, playerValue, dealerValue, outcome, multiplier, won: multiplier > 1 }
}

export function blackjackPayout(wager, multiplier) {
  return Math.floor(wager * multiplier)
}
