import { blackjackHandValue } from './nighty-games.js'

export const NIGHTY_PARTY_EXPIRY_SECONDS = 300
export const NIGHTY_MINES_CELLS = 16
export const NIGHTY_MIN_MINES = 1
export const NIGHTY_MAX_MINES = 10
export const NIGHTY_CRASH_MULTIPLIERS = Object.freeze([
  1.10, 1.25, 1.45, 1.70, 2.00, 2.40, 3.00, 4.00, 5.50, 8.00, 12.00, 20.00,
])

const CARD_SUITS = ['♠', '♥', '♦', '♣']
const CARD_RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']

function boundedIndex(random, length) {
  return Math.min(length - 1, Math.max(0, Math.floor(Number(random()) * length)))
}

function shuffled(values, random = Math.random) {
  const result = [...values]
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = boundedIndex(random, index + 1)
    ;[result[index], result[target]] = [result[target], result[index]]
  }
  return result
}

export function createNightyMinesState(mineCount = 3, random = Math.random) {
  const count = Math.min(NIGHTY_MAX_MINES, Math.max(NIGHTY_MIN_MINES, Math.trunc(Number(mineCount)) || 3))
  return {
    phase: 'active',
    mineCount: count,
    mines: shuffled(Array.from({ length: NIGHTY_MINES_CELLS }, (_, index) => index), random).slice(0, count),
    revealed: [],
    lastPick: null,
  }
}

export function nightyMinesMultiplier(state) {
  const picks = state.revealed.length
  if (picks === 0) return 1
  let fairMultiplier = 1
  for (let index = 0; index < picks; index += 1) {
    fairMultiplier *= (NIGHTY_MINES_CELLS - index) / (NIGHTY_MINES_CELLS - state.mineCount - index)
  }
  return Math.max(1, Math.floor(fairMultiplier * 0.97 * 100) / 100)
}

export function pickNightyMine(state, cell) {
  const index = Math.trunc(Number(cell))
  if (state.phase !== 'active' || index < 0 || index >= NIGHTY_MINES_CELLS || state.revealed.includes(index)) {
    return { state, outcome: 'invalid' }
  }
  if (state.mines.includes(index)) {
    return { state: { ...state, phase: 'lost', lastPick: index }, outcome: 'mine' }
  }
  const revealed = [...state.revealed, index].sort((left, right) => left - right)
  const cleared = revealed.length === NIGHTY_MINES_CELLS - state.mineCount
  return {
    state: { ...state, phase: cleared ? 'cleared' : 'active', revealed, lastPick: index },
    outcome: cleared ? 'cleared' : 'safe',
  }
}

export function nightyMinesPayout(wager, state) {
  return Math.floor(Number(wager) * nightyMinesMultiplier(state))
}

export function createNightyCrashState(baseWager, random = Math.random) {
  // Early crashes are deliberately more common; the displayed multipliers and
  // the hidden crash step are fixed at round creation and never rerolled.
  const weightedSteps = [1, 1, 2, 2, 3, 3, 4, 5, 6, 7, 8, 9, 10, 11]
  return {
    phase: 'lobby',
    baseWager: Number(baseWager),
    step: 0,
    crashStep: weightedSteps[boundedIndex(random, weightedSteps.length)],
    players: {},
  }
}

export function startNightyCrash(state, userIds) {
  return {
    ...state,
    phase: 'active',
    step: 0,
    players: Object.fromEntries(userIds.map((userId) => [String(userId), { status: 'riding', multiplier: null, payout: 0 }])),
  }
}

export function advanceNightyCrash(state) {
  if (state.phase !== 'active') return { state, outcome: 'invalid' }
  const nextStep = state.step + 1
  if (nextStep >= state.crashStep) {
    return { state: { ...state, phase: 'crashed', step: nextStep }, outcome: 'crashed' }
  }
  return { state: { ...state, step: nextStep }, outcome: 'advanced' }
}

export function nightyCrashMultiplier(state) {
  if (Number(state.step) <= 0) return 1
  return NIGHTY_CRASH_MULTIPLIERS[Math.min(state.step - 1, NIGHTY_CRASH_MULTIPLIERS.length - 1)]
}

export function cashOutNightyCrash(state, userId, wager) {
  const id = String(userId)
  const player = state.players[id]
  if (state.phase !== 'active' || !player || player.status !== 'riding') return { state, outcome: 'invalid' }
  const multiplier = nightyCrashMultiplier(state)
  const payout = Math.floor(Number(wager) * multiplier)
  const players = { ...state.players, [id]: { status: 'cashed_out', multiplier, payout } }
  const finished = Object.values(players).every((entry) => entry.status === 'cashed_out')
  return {
    state: { ...state, phase: finished ? 'completed' : state.phase, players },
    outcome: finished ? 'completed' : 'cashed_out',
    payout,
  }
}

export function createShadowFighter(userId, character) {
  const maxHp = 100 + Math.round(character.power / 20)
  return {
    userId: String(userId),
    characterId: character.id,
    characterName: character.name,
    power: character.power,
    hp: maxHp,
    maxHp,
    skillReady: true,
    action: null,
  }
}

export function createShadowDuelState(challenger, opponent, wager) {
  return {
    phase: 'active',
    round: 1,
    maxRounds: 5,
    wager: Number(wager),
    order: [challenger.userId, opponent.userId],
    fighters: {
      [challenger.userId]: challenger,
      [opponent.userId]: opponent,
    },
    log: 'Both fighters are choosing their first move.',
    winnerId: null,
    loserId: null,
    tied: false,
  }
}

function shadowDamage(fighter, action) {
  if (action === 'skill') return 25 + Math.round(fighter.power / 40)
  return 16 + Math.round(fighter.power / 50)
}

export function chooseShadowAction(state, userId, action) {
  const id = String(userId)
  const fighter = state.fighters[id]
  if (state.phase !== 'active' || !fighter || fighter.action || !['attack', 'defend', 'skill'].includes(action)) {
    return { state, outcome: 'invalid' }
  }
  if (action === 'skill' && !fighter.skillReady) return { state, outcome: 'skill_used' }
  const fighters = {
    ...state.fighters,
    [id]: { ...fighter, action, skillReady: action === 'skill' ? false : fighter.skillReady },
  }
  const waiting = state.order.some((fighterId) => !fighters[fighterId].action)
  if (waiting) return { state: { ...state, fighters, log: `<@${id}> locked in a hidden move.` }, outcome: 'locked' }

  const [firstId, secondId] = state.order
  const first = { ...fighters[firstId] }
  const second = { ...fighters[secondId] }
  const firstAction = first.action
  const secondAction = second.action
  let firstDamage = firstAction === 'defend' ? 0 : shadowDamage(first, firstAction)
  let secondDamage = secondAction === 'defend' ? 0 : shadowDamage(second, secondAction)
  if (secondAction === 'defend') firstDamage = Math.floor(firstDamage * (firstAction === 'skill' ? 0.60 : 0.35))
  if (firstAction === 'defend') secondDamage = Math.floor(secondDamage * (secondAction === 'skill' ? 0.60 : 0.35))
  if (firstAction === 'defend' && secondAction !== 'defend') firstDamage += 4
  if (secondAction === 'defend' && firstAction !== 'defend') secondDamage += 4
  first.hp = Math.max(0, first.hp - secondDamage)
  second.hp = Math.max(0, second.hp - firstDamage)
  const finishedByHp = first.hp === 0 || second.hp === 0
  const finishedByRounds = state.round >= state.maxRounds
  let winnerId = null
  let loserId = null
  let tied = false
  if (finishedByHp || finishedByRounds) {
    if (first.hp === second.hp) tied = true
    else {
      winnerId = first.hp > second.hp ? firstId : secondId
      loserId = winnerId === firstId ? secondId : firstId
    }
  }
  const finished = finishedByHp || finishedByRounds
  first.action = null
  second.action = null
  return {
    state: {
      ...state,
      phase: finished ? 'completed' : 'active',
      round: finished ? state.round : state.round + 1,
      fighters: { ...fighters, [firstId]: first, [secondId]: second },
      log: `${first.characterName} used ${firstAction}; ${second.characterName} used ${secondAction}. Damage: ${firstDamage}/${secondDamage}.`,
      winnerId,
      loserId,
      tied,
    },
    outcome: finished ? (tied ? 'tie' : 'completed') : 'round_complete',
  }
}

export function createNightyBlackjackDeck(random = Math.random) {
  return shuffled(CARD_SUITS.flatMap((suit) => CARD_RANKS.map((rank) => `${rank}${suit}`)), random)
}

function drawCard(state) {
  return state.deck.pop()
}

function blackjackRank(card) {
  return String(card).slice(0, -1)
}

export function startPartyBlackjack(baseWager, participants, random = Math.random) {
  const state = {
    phase: 'active',
    baseWager: Number(baseWager),
    deck: createNightyBlackjackDeck(random),
    dealer: [],
    order: participants.map((player) => String(player.userId)),
    currentUserId: null,
    players: {},
  }
  state.dealer.push(drawCard(state), drawCard(state))
  for (const participant of participants) {
    const cards = [drawCard(state), drawCard(state)]
    const natural = blackjackHandValue(cards) === 21
    state.players[participant.userId] = {
      hands: [{ cards, wager: Number(participant.wager), status: natural ? 'blackjack' : 'playing', fromSplit: false }],
      activeHand: 0,
    }
  }
  state.currentUserId = state.order.find((userId) => playerNeedsTurn(state.players[userId])) || null
  if (!state.currentUserId) state.phase = 'dealer'
  return state
}

function playerNeedsTurn(player) {
  return player?.hands?.some((hand) => hand.status === 'playing') || false
}

function nextBlackjackTurn(state, currentId) {
  const currentIndex = state.order.indexOf(currentId)
  for (let offset = 1; offset <= state.order.length; offset += 1) {
    const candidate = state.order[(currentIndex + offset) % state.order.length]
    if (playerNeedsTurn(state.players[candidate])) return candidate
  }
  return null
}

function activeBlackjackHand(player) {
  return player?.hands?.[player.activeHand] || null
}

export function partyBlackjackActionCost(state, userId, action) {
  if (state.phase !== 'active' || state.currentUserId !== String(userId)) return null
  const player = state.players[String(userId)]
  const hand = activeBlackjackHand(player)
  if (!hand || hand.status !== 'playing') return null
  if (action === 'double' && hand.cards.length === 2) return hand.wager
  if (action === 'split' && hand.cards.length === 2 && blackjackRank(hand.cards[0]) === blackjackRank(hand.cards[1])) return hand.wager
  return action === 'hit' || action === 'stand' ? 0 : null
}

export function playPartyBlackjack(state, userId, action) {
  const id = String(userId)
  const cost = partyBlackjackActionCost(state, id, action)
  if (cost === null) return { state, outcome: 'invalid', additionalWager: 0 }
  const next = structuredClone(state)
  const player = next.players[id]
  let hand = activeBlackjackHand(player)
  if (action === 'hit') {
    hand.cards.push(drawCard(next))
    if (blackjackHandValue(hand.cards) >= 21) hand.status = blackjackHandValue(hand.cards) > 21 ? 'bust' : 'stood'
  } else if (action === 'stand') {
    hand.status = 'stood'
  } else if (action === 'double') {
    hand.wager += cost
    hand.cards.push(drawCard(next))
    hand.status = blackjackHandValue(hand.cards) > 21 ? 'bust' : 'stood'
  } else if (action === 'split') {
    const [left, right] = hand.cards
    player.hands.splice(player.activeHand, 1,
      { cards: [left, drawCard(next)], wager: hand.wager, status: 'playing', fromSplit: true },
      { cards: [right, drawCard(next)], wager: hand.wager, status: 'playing', fromSplit: true },
    )
    hand = activeBlackjackHand(player)
  }

  while (player.activeHand < player.hands.length && player.hands[player.activeHand].status !== 'playing') player.activeHand += 1
  if (!playerNeedsTurn(player)) next.currentUserId = nextBlackjackTurn(next, id)
  if (!next.currentUserId) next.phase = 'dealer'
  return { state: next, outcome: next.phase === 'dealer' ? 'dealer' : 'played', additionalWager: cost }
}

export function finishPartyBlackjack(state) {
  const next = structuredClone(state)
  while (blackjackHandValue(next.dealer) < 17 && next.deck.length > 0) next.dealer.push(drawCard(next))
  const dealerValue = blackjackHandValue(next.dealer)
  const dealerNatural = next.dealer.length === 2 && dealerValue === 21
  const payouts = []
  for (const userId of next.order) {
    let payout = 0
    let won = false
    const player = next.players[userId]
    for (const hand of player.hands) {
      const value = blackjackHandValue(hand.cards)
      if (value > 21) hand.outcome = 'bust'
      else if (!hand.fromSplit && hand.cards.length === 2 && value === 21) {
        if (dealerNatural) {
          hand.outcome = 'push'
          payout += hand.wager
        } else {
          hand.outcome = 'blackjack'
          payout += Math.floor(hand.wager * 2.5)
          won = true
        }
      } else if (dealerValue > 21 || value > dealerValue) {
        hand.outcome = 'win'
        payout += hand.wager * 2
        won = true
      } else if (value === dealerValue) {
        hand.outcome = 'push'
        payout += hand.wager
      } else hand.outcome = 'loss'
    }
    payouts.push({ userId, payout, won })
  }
  next.phase = 'completed'
  next.currentUserId = null
  return { state: next, payouts, dealerValue }
}
