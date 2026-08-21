import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EMOJI_REACTIONS,
  GUESS_THE_EMOJI_COMMAND,
  NUMBER_REACTIONS,
  assertSecretEmojis,
  attemptsUsed,
  countCorrectPositions,
  createEmojiGame,
  createGuessTheEmojiWorkflow,
  evaluateEmojiGuess,
  getReactionForCount,
  parseEmojis,
  renderEmojiGameOver,
  renderEmojiGameStart,
  renderEmojiWin,
  shuffleArray,
  shuffleEmojiSequence,
} from './guess-the-emoji.js'
import { createEndGameWorkflow } from './minigame-end.js'

const CHANNEL_ID = '1208605026868535387'
const GAME_ID = 'e1m0j100'

function game({
  emojis = '🥰 🫡 🐱 💚 😺 🛡️ 🎯',
  hostId = 'host-1',
  prize = null,
} = {}) {
  return createEmojiGame({
    gameId: GAME_ID,
    channelId: CHANNEL_ID,
    guildId: 'guild-1',
    hostId,
    emojis,
    prize,
  })
}

function commandInteraction({
  userId = 'host-1',
  emojis = '🥰 🫡 🐱 💚 😺 🛡️ 🎯',
  prize = null,
  administrator = false,
} = {}) {
  const state = { replies: [] }
  const values = { emojis, prize }
  return {
    state,
    isChatInputCommand: () => true,
    commandName: GUESS_THE_EMOJI_COMMAND.name,
    guildId: 'guild-1',
    channelId: CHANNEL_ID,
    user: { id: userId },
    member: { permissions: { has: () => administrator } },
    options: { getString: (name) => values[name] ?? null },
    reply: async (payload) => {
      state.replies.push(payload)
    },
    editReply: async (payload) => {
      state.replies.push(payload)
    },
    fetchReply: async () => ({ id: 'game-msg' }),
  }
}

function guessMessage({
  id = 'guess-message-1',
  userId = 'player-1',
  content = '🥰 🫡 🐱 💚 😺 🛡️ 🎯',
  bot = false,
} = {}) {
  const state = { reactions: [], sent: [] }
  return {
    state,
    id,
    author: { id: userId, bot },
    guildId: 'guild-1',
    channelId: CHANNEL_ID,
    content,
    inGuild: () => true,
    react: async (emoji) => {
      state.reactions.push(emoji)
    },
    channel: {
      send: async (payload) => {
        state.sent.push(payload)
      },
    },
  }
}

test('GUESS_THE_EMOJI_COMMAND options and properties', () => {
  assert.equal(GUESS_THE_EMOJI_COMMAND.name, 'guesstheemoji')
  assert.deepEqual(
    GUESS_THE_EMOJI_COMMAND.options.map((option) => [option.name, option.required === true, option.maxLength]),
    [['emojis', true, 1000], ['prize', false, 100]],
  )
})

test('parseEmojis extracts Unicode and custom Discord emojis', () => {
  const parsed = parseEmojis('🥰 🫡 🐱 💚 😺 🛡️ 🎯')
  assert.deepEqual(parsed, ['🥰', '🫡', '🐱', '💚', '😺', '🛡️', '🎯'])

  const custom = parseEmojis('<:custom_emoji:123456789> <a:anim_emoji:987654321>')
  assert.deepEqual(custom, ['<:custom_emoji:123456789>', '<a:anim_emoji:987654321>'])

  assert.equal(parseEmojis('Hello world 🥰 🫡'), null)
  assert.deepEqual(parseEmojis(''), [])
  assert.deepEqual(parseEmojis(null), [])
})

test('assertSecretEmojis requires between 7 and 10 emojis', () => {
  const seq7 = '🥰 🫡 🐱 💚 😺 🛡️ 🎯'
  const seq10 = '🥰 🫡 🐱 💚 😺 🛡️ 🎯 🎲 🚀 💎'
  const seq6 = '🥰 🫡 🐱 💚 😺 🛡️'
  const seq11 = '🥰 🫡 🐱 💚 😺 🛡️ 🎯 🎲 🚀 💎 🏆'
  const customSeq10 = Array.from({ length: 10 }, (_, i) => `<:long_custom_emoji_name_${i}:123456789012345678>`).join(' ')

  assert.deepEqual(assertSecretEmojis(seq7), ['🥰', '🫡', '🐱', '💚', '😺', '🛡️', '🎯'])
  assert.equal(assertSecretEmojis(seq10).length, 10)
  assert.equal(customSeq10.length > 200, true)
  assert.equal(assertSecretEmojis(customSeq10).length, 10)
  assert.throws(() => assertSecretEmojis(seq6), /7 to 10 emojis/)
  assert.throws(() => assertSecretEmojis(seq11), /7 to 10 emojis/)
  assert.throws(() => assertSecretEmojis('hello world'), /7 to 10 emojis/)
})

test('shuffleArray and shuffleEmojiSequence randomize order', () => {
  const emojis = ['🥰', '🫡', '🐱', '💚', '😺', '🛡️', '🎯']
  const shuffled = shuffleArray(emojis, Math.random)
  assert.equal(shuffled.length, emojis.length)
  assert.deepEqual(shuffled.sort(), [...emojis].sort())

  // Test deterministic shuffle override when same as original
  const deterministicSeq = shuffleEmojiSequence(['🥰', '🫡', '🐱', '💚', '😺', '🛡️', '🎯'], () => 0)
  assert.notDeepEqual(deterministicSeq, ['🥰', '🫡', '🐱', '💚', '😺', '🛡️', '🎯'])
})

test('countCorrectPositions calculates exact position matches', () => {
  const secret = ['🥰', '🫡', '🐱', '💚', '😺', '🛡️', '🎯']
  
  // All correct
  assert.equal(countCorrectPositions(['🥰', '🫡', '🐱', '💚', '😺', '🛡️', '🎯'], secret), 7)
  // Partial correct (index 2 and 4 match)
  assert.equal(countCorrectPositions(['🫡', '🥰', '🐱', '🛡️', '😺', '💚', '🎯'], secret), 3)
  // 0 correct
  assert.equal(countCorrectPositions(['🛡️', '😺', '💚', '🐱', '🎯', '🥰', '🫡'], secret), 0)
})

test('getReactionForCount maps counts to digit emojis or cross mark', () => {
  assert.equal(getReactionForCount(0), '❌')
  assert.equal(getReactionForCount(1), '1️⃣')
  assert.equal(getReactionForCount(3), '3️⃣')
  assert.equal(getReactionForCount(10), '🔟')
})

test('evaluateEmojiGuess handles guesses, reactions, and victory', () => {
  const active = game({ emojis: '🥰 🫡 🐱 💚 😺 🛡️ 🎯' })
  
  // Host guess when hostMayGuess is disabled
  active.hostMayGuess = false
  assert.equal(evaluateEmojiGuess(active, 'host-1', '🥰 🫡 🐱 💚 😺 🛡️ 🎯').status, 'host_locked')

  // Host guess allowed when hostMayGuess is true
  active.hostMayGuess = true

  // Chat message (non-emoji)
  assert.equal(evaluateEmojiGuess(active, 'player-1', 'Good game everyone!').status, 'not_a_guess')

  // Guess with duplicate emojis
  const dupGame = game({ emojis: '🥰 🫡 🐱 💚 😺 🛡️ 🎯' })
  const dupRes = evaluateEmojiGuess(dupGame, 'player-1', '🥰 🥰 🐱 💚 😺 🛡️ 🎯')
  assert.equal(dupRes.status, 'wrong')
  assert.equal(dupRes.count, 0)
  assert.equal(dupRes.reaction, '❌')
  assert.equal(dupRes.used, 1)

  // Guess with lacking emojis (e.g. 3 emojis but secret is 7)
  const lackGame = game({ emojis: '🥰 🫡 🐱 💚 😺 🛡️ 🎯' })
  const lackRes = evaluateEmojiGuess(lackGame, 'player-1', '🥰 🫡 🐱')
  assert.equal(lackRes.status, 'wrong')
  assert.equal(lackRes.count, 0)
  assert.equal(lackRes.reaction, '❌')
  assert.equal(lackRes.used, 1)

  // Wrong guess with partial position match
  const wrongRes = evaluateEmojiGuess(active, 'player-1', '🥰 🐱 🫡 💚 😺 🛡️ 🎯') // index 0, 3, 4, 5, 6 match -> 5
  assert.equal(wrongRes.status, 'wrong')
  assert.equal(wrongRes.count, 5)
  assert.equal(wrongRes.reaction, '5️⃣')
  // 5 guess limit test
  const testGame = game({ emojis: '🥰 🫡 🐱 💚 😺 🛡️ 🎯' })
  for (let i = 1; i <= 5; i++) {
    const res = evaluateEmojiGuess(testGame, 'player-2', '🥰 🐱 🫡 💚 😺 🛡️ 🎯')
    assert.equal(res.status, 'wrong')
    assert.equal(res.remaining, 5 - i)
  }
  // 6th guess gets eliminated status
  const eliminatedRes = evaluateEmojiGuess(testGame, 'player-2', '🥰 🐱 🫡 💚 😺 🛡️ 🎯')
  assert.equal(eliminatedRes.status, 'eliminated')

  // Correct guess
  const correctRes = evaluateEmojiGuess(active, 'player-1', '🥰 🫡 🐱 💚 😺 🛡️ 🎯')
  assert.equal(correctRes.status, 'correct')
  assert.equal(active.finished, true)
  assert.equal(active.winnerId, 'player-1')
})

test('workflow starts game and announces shuffled emoji pool', async () => {
  const games = new Map()
  const workflow = createGuessTheEmojiWorkflow({ games, gameIdImpl: () => GAME_ID })
  const interaction = commandInteraction({ emojis: '🥰 🫡 🐱 💚 😺 🛡️ 🎯', prize: '1,000 Scrim Points' })

  const result = await workflow.handleInteraction(interaction)
  assert.equal(result.status, 'started')
  assert.equal(games.has(CHANNEL_ID), true)

  const reply = interaction.state.replies[0]
  assert.match(reply.content, /# Guess The Emoji/)
  assert.match(reply.content, /Shuffled Emojis:/)
  assert.match(reply.content, /Prize: \*\*1,000 Scrim Points\*\*/)
})

test('player guessing correct sequence receives reaction and victory message', async () => {
  const games = new Map()
  const workflow = createGuessTheEmojiWorkflow({ games, gameIdImpl: () => GAME_ID })
  await workflow.handleInteraction(commandInteraction({ emojis: '🥰 🫡 🐱 💚 😺 🛡️ 🎯' }))

  const wrongMsg = guessMessage({ userId: 'player-1', content: '🥰 🐱 🫡 💚 😺 🛡️ 🎯' })
  const wrongRes = await workflow.handleMessage(wrongMsg)
  assert.equal(wrongRes.status, 'wrong')
  assert.equal(wrongMsg.state.reactions.includes('5️⃣'), true)

  const winMsg = guessMessage({ userId: 'player-1', content: '🥰 🫡 🐱 💚 😺 🛡️ 🎯' })
  const winRes = await workflow.handleMessage(winMsg)
  assert.equal(winRes.status, 'won')
  assert.equal(winMsg.state.reactions.includes('✅'), true)
  assert.match(winMsg.state.sent[0].content, /# Guessed It!/)
})

test('an emoji-game winner receives one 50 NRT award', async () => {
  const games = new Map()
  const awardCalls = []
  const workflow = createGuessTheEmojiWorkflow({
    games,
    gameIdImpl: () => GAME_ID,
    onWinner: async (context) => {
      awardCalls.push(context)
      return { status: 'awarded', amount: 50, balance: 250 }
    },
  })
  await workflow.handleInteraction(commandInteraction())
  const winner = guessMessage({ id: 'emoji-winning-message', userId: 'emoji-winner' })
  const result = await workflow.handleMessage(winner)
  assert.equal(result.nrtAward.status, 'awarded')
  assert.equal(awardCalls.length, 1)
  assert.equal(awardCalls[0].gameType, 'emoji')
  assert.equal(awardCalls[0].sourceMessageId, 'emoji-winning-message')
  assert.match(winner.state.sent[0].content, /NRT Reward: \*\*\+50 NRT\*\*/)
})

test('endGame allows host or admin to terminate game', async () => {
  const games = new Map()
  const emojiWorkflow = createGuessTheEmojiWorkflow({ games, gameIdImpl: () => GAME_ID })
  await emojiWorkflow.handleInteraction(commandInteraction({ userId: 'host-1', emojis: '🥰 🫡 🐱 💚 😺 🛡️ 🎯' }))

  const endWorkflow = createEndGameWorkflow({ workflows: [emojiWorkflow] })

  // Non-host non-admin attempt
  const bystanderRes = emojiWorkflow.endGame({ channelId: CHANNEL_ID, userId: 'player-9', isAdministrator: false })
  assert.equal(bystanderRes.status, 'unauthorized')

  // Host attempt
  const endResult = await endWorkflow.handleInteraction({
    isChatInputCommand: () => true,
    commandName: 'endgame',
    guildId: 'guild-1',
    channelId: CHANNEL_ID,
    user: { id: 'host-1' },
    member: { permissions: { has: () => false } },
    reply: async () => undefined,
  })
  assert.equal(endResult.status, 'ended')
  assert.equal(games.get(CHANNEL_ID).finished, true)
})
