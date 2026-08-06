import assert from 'node:assert/strict'
import test from 'node:test'
import {
  GUESS_THE_WORD_COMMAND,
  WORD_ATTEMPTS,
  WORD_REACTIONS,
  assertSecretWord,
  attemptsLeft,
  createGuessTheWordWorkflow,
  createWordGame,
  evaluateWordGuess,
  normalizeWord,
  parseWordGuess,
  renderWordGameStart,
  renderWordWin,
} from './guess-the-word.js'

const CHANNEL_ID = '1208605026868535387'
const GAME_ID = 'a1b2c3d4'

function game({ word = 'bloodstrike', hostId = 'host-1', hint = 'The game we play', prize = null } = {}) {
  return createWordGame({
    gameId: GAME_ID,
    channelId: CHANNEL_ID,
    guildId: 'guild-1',
    hostId,
    word,
    hint,
    prize,
  })
}

function commandInteraction({
  userId = 'host-1',
  word = 'bloodstrike',
  hint = 'The game we play',
  prize = null,
  administrator = false,
} = {}) {
  const state = { replies: [] }
  const values = { word, hint, prize }
  return {
    state,
    isChatInputCommand: () => true,
    commandName: GUESS_THE_WORD_COMMAND.name,
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

function guessMessage({ userId = 'player-1', content = 'nightraid', bot = false } = {}) {
  const state = { reactions: [], sent: [] }
  return {
    state,
    author: { id: userId, bot },
    channelId: CHANNEL_ID,
    content,
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

function workflowWith(existing = null) {
  const games = new Map()
  if (existing) games.set(existing.channelId, existing)
  return {
    games,
    workflow: createGuessTheWordWorkflow({ games, gameIdImpl: () => GAME_ID }),
  }
}

test('the command takes a word, a required hint, and an optional prize', () => {
  assert.equal(GUESS_THE_WORD_COMMAND.name, 'guesstheword')
  assert.deepEqual(
    GUESS_THE_WORD_COMMAND.options.map((option) => [option.name, option.required === true]),
    [['word', true], ['hint', true], ['prize', false]],
  )
})

test('five guesses each, same as the number game', () => {
  assert.equal(WORD_ATTEMPTS, 5)
})

test('matching ignores case and accents', () => {
  assert.equal(normalizeWord('  BloodStrike '), 'bloodstrike')
  assert.equal(normalizeWord('Ñoño'), 'nono')
  const active = game({ word: 'NightRaid' })
  assert.equal(evaluateWordGuess(active, 'p1', 'nightraid').status, 'correct')
})

test('only a single word counts as a guess', () => {
  assert.equal(parseWordGuess('bloodstrike'), 'bloodstrike')
  assert.equal(parseWordGuess("  don't  "), "don't")
  assert.equal(parseWordGuess('night-raid'), 'night-raid')
  assert.equal(parseWordGuess('is it bloodstrike'), null)
  assert.equal(parseWordGuess(''), null)
  assert.equal(parseWordGuess('https://example.com/x'), null)
  assert.equal(parseWordGuess('x'.repeat(33)), null)
})

test('a multi-word or empty secret is refused', () => {
  assert.equal(assertSecretWord(' bloodstrike '), 'bloodstrike')
  assert.throws(() => assertSecretWord('blood strike'), /single word/)
  assert.throws(() => assertSecretWord(''), /single word/)
  assert.throws(() => assertSecretWord('x'.repeat(33)), /single word/)
})

test('the board shows the hint', () => {
  const board = renderWordGameStart({ secret: 'bloodstrike', hint: 'The game we play', prize: '500 diamonds' })
  assert.match(board, /# Game Started/)
  assert.match(board, /- Hint: \*\*The game we play\*\*/)
  assert.match(board, /- You have \*\*5\*\* guesses each\./)
  assert.match(board, /- Prize: \*\*500 diamonds\*\*/)
  /* The word itself is never on the board. */
  assert.equal(board.includes('bloodstrike'), false)
})

test('no board or win text carries an emoji', () => {
  const emoji = /\p{Extended_Pictographic}/u
  assert.equal(emoji.test(renderWordGameStart({ secret: 'abc', hint: 'x', prize: 'y' })), false)
  assert.equal(emoji.test(renderWordWin({
    userId: 'p1',
    game: { secret: 'abc', prize: 'y' },
    result: { used: 2 },
  })), false)
})

test('each player gets their own five guesses', () => {
  const active = game()
  for (let index = 0; index < WORD_ATTEMPTS; index++) {
    assert.equal(evaluateWordGuess(active, 'player-1', 'wrong').status, 'wrong')
  }
  assert.equal(evaluateWordGuess(active, 'player-1', 'wrong').status, 'eliminated')
  assert.equal(attemptsLeft(active, 'player-2'), WORD_ATTEMPTS)
})

test('chat never costs an attempt', () => {
  const active = game()
  assert.equal(evaluateWordGuess(active, 'player-1', 'is it bloodstrike').status, 'not_a_guess')
  assert.equal(attemptsLeft(active, 'player-1'), WORD_ATTEMPTS)
})

test('the host who set the word cannot play', () => {
  const active = game()
  assert.deepEqual(evaluateWordGuess(active, 'host-1', 'bloodstrike'), { status: 'host_locked' })
  assert.equal(active.finished, false)
})

test('the right word wins and closes the game', () => {
  const active = game()
  const result = evaluateWordGuess(active, 'player-1', 'bloodstrike')
  assert.equal(result.status, 'correct')
  assert.equal(active.winnerId, 'player-1')
  assert.deepEqual(evaluateWordGuess(active, 'player-2', 'bloodstrike'), { status: 'finished' })
})

test('starting a game posts the board and hides the word', async () => {
  const { workflow, games } = workflowWith()
  const interaction = commandInteraction({ word: 'Bloodstrike', hint: 'The game we play' })
  const result = await workflow.handleInteraction(interaction)
  assert.equal(result.status, 'started')
  assert.equal(games.get(CHANNEL_ID).secret, 'Bloodstrike')
  const [payload] = interaction.state.replies
  assert.match(payload.content, /- Hint: \*\*The game we play\*\*/)
  assert.equal(payload.content.toLowerCase().includes('bloodstrike'), false)
  assert.equal('components' in payload, false)
})

test('a multi-word answer is refused before a game starts', async () => {
  const { workflow, games } = workflowWith()
  const interaction = commandInteraction({ word: 'blood strike' })
  const result = await workflow.handleInteraction(interaction)
  assert.equal(result.status, 'rejected')
  assert.equal(games.size, 0)
  assert.match(interaction.state.replies[0].content, /single word/)
})

test('a wrong guess gets a cross and nothing else', async () => {
  const { workflow } = workflowWith(game())
  const miss = guessMessage({ content: 'valorant' })
  assert.equal((await workflow.handleMessage(miss)).status, 'wrong')
  assert.deepEqual(miss.state.reactions, ['❌'])
  assert.deepEqual(miss.state.sent, [])
})

test('the winning guess is ticked and announced', async () => {
  const { workflow } = workflowWith(game({ prize: '500 diamonds' }))
  const winner = guessMessage({ userId: 'player-7', content: 'BLOODSTRIKE' })
  const result = await workflow.handleMessage(winner)
  assert.equal(result.status, 'won')
  assert.equal(result.winnerId, 'player-7')
  assert.deepEqual(winner.state.reactions, ['✅'])
  assert.match(winner.state.sent[0].content, /# Guessed It/)
  assert.match(winner.state.sent[0].content, /\*\*bloodstrike\*\*/)
  assert.match(winner.state.sent[0].content, /Prize: \*\*500 diamonds\*\*/)
})

test('sentences and bot messages are left alone', async () => {
  const { workflow } = workflowWith(game())
  for (const content of ['is it bloodstrike', 'gg wp everyone', '']) {
    const chat = guessMessage({ content })
    assert.equal((await workflow.handleMessage(chat)).status, 'ignored')
    assert.deepEqual(chat.state.reactions, [])
  }
  const own = guessMessage({ content: 'bloodstrike', bot: true })
  assert.equal((await workflow.handleMessage(own)).status, 'ignored')
  assert.deepEqual(own.state.reactions, [])
})

test('a player out of guesses gets the stop sign', async () => {
  const running = game()
  running.attempts.set('player-1', WORD_ATTEMPTS)
  const { workflow } = workflowWith(running)
  const spent = guessMessage({ content: 'valorant' })
  assert.equal((await workflow.handleMessage(spent)).status, 'eliminated')
  assert.deepEqual(spent.state.reactions, [WORD_REACTIONS.eliminated])
})

test('the host chatting a word is ignored, not answered', async () => {
  const { workflow } = workflowWith(game())
  const hostGuess = guessMessage({ userId: 'host-1', content: 'bloodstrike' })
  assert.equal((await workflow.handleMessage(hostGuess)).status, 'ignored')
  assert.deepEqual(hostGuess.state.reactions, [])
})

test('a second player cannot start over a running game', async () => {
  const { workflow } = workflowWith(game())
  const interaction = commandInteraction({ userId: 'player-9' })
  const result = await workflow.handleInteraction(interaction)
  assert.equal(result.status, 'rejected')
  assert.match(interaction.state.replies[0].content, /already running/)
})

test('the host can replace their own running game', async () => {
  const running = game()
  const { workflow } = workflowWith(running)
  const result = await workflow.handleInteraction(commandInteraction({ userId: 'host-1' }))
  assert.equal(result.status, 'started')
  assert.equal(result.replaced, true)
  assert.equal(running.finished, true)
})

test('other commands are ignored', async () => {
  const { workflow } = workflowWith()
  const result = await workflow.handleInteraction({
    isChatInputCommand: () => true,
    commandName: 'guessthenumber',
  })
  assert.equal(result.status, 'ignored')
})
