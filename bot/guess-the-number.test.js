import assert from 'node:assert/strict'
import test from 'node:test'
import {
  GUESS_ATTEMPTS,
  GUESS_MAXIMUM,
  GUESS_MINIMUM,
  GUESS_REACTIONS,
  GUESS_THE_NUMBER_COMMAND,
  attemptsLeft,
  cleanPrize,
  createGuessGame,
  createGuessTheNumberWorkflow,
  evaluateGuess,
  parseGuessValue,
  renderGameStart,
  renderWin,
} from './guess-the-number.js'

const CHANNEL_ID = '1208605026868535387'
const GAME_ID = 'a1b2c3d4'

function game({ secret = 5_000, hostId = 'host-1', hostSet = false, prize = null } = {}) {
  return createGuessGame({
    gameId: GAME_ID,
    channelId: CHANNEL_ID,
    guildId: 'guild-1',
    hostId,
    secret: hostSet ? secret : null,
    prize,
    randomImpl: () => secret,
  })
}

function commandInteraction({
  userId = 'host-1',
  number = null,
  prize = null,
  administrator = false,
} = {}) {
  const state = { replies: [] }
  return {
    state,
    isChatInputCommand: () => true,
    commandName: GUESS_THE_NUMBER_COMMAND.name,
    guildId: 'guild-1',
    channelId: CHANNEL_ID,
    user: { id: userId },
    member: { permissions: { has: () => administrator } },
    options: { getInteger: () => number, getString: () => prize },
    reply: async (payload) => {
      state.replies.push(payload)
    },
    editReply: async (payload) => {
      state.replies.push(payload)
    },
    fetchReply: async () => ({ id: 'game-msg' }),
  }
}

function guessMessage({ userId = 'player-1', content = '4200', bot = false } = {}) {
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
    workflow: createGuessTheNumberWorkflow({
      games,
      gameIdImpl: () => GAME_ID,
      randomImpl: () => 5_000,
    }),
  }
}

test('the command has no min or max option, just the number and the prize', () => {
  assert.equal(GUESS_THE_NUMBER_COMMAND.name, 'guessthenumber')
  assert.deepEqual(
    GUESS_THE_NUMBER_COMMAND.options.map((option) => option.name),
    ['number', 'prize'],
  )
  const [numberOption, prizeOption] = GUESS_THE_NUMBER_COMMAND.options
  assert.equal(numberOption.required, false)
  assert.equal(numberOption.minValue, 1_000)
  assert.equal(numberOption.maxValue, 9_999)
  assert.equal(prizeOption.required, false)
})

test('the range is fixed at 1000 to 9999 with five guesses each', () => {
  assert.equal(GUESS_MINIMUM, 1_000)
  assert.equal(GUESS_MAXIMUM, 9_999)
  assert.equal(GUESS_ATTEMPTS, 5)
})

test('up is higher and down is lower', () => {
  assert.equal(GUESS_REACTIONS.higher, '⬆️')
  assert.equal(GUESS_REACTIONS.lower, '⬇️')
})

test('only a bare number inside the range counts as a guess', () => {
  assert.equal(parseGuessValue('4200'), 4_200)
  assert.equal(parseGuessValue(' 4,200 '), 4_200)
  assert.equal(parseGuessValue('999'), null)
  assert.equal(parseGuessValue('10000'), null)
  assert.equal(parseGuessValue('42.5'), null)
  assert.equal(parseGuessValue('4200 is my lucky number'), null)
  assert.equal(parseGuessValue('gg wp'), null)
})

test('the prize is flattened to one harmless line', () => {
  assert.equal(cleanPrize('  500  diamonds '), '500 diamonds')
  assert.equal(cleanPrize('a\nb`c`'), 'a b c')
  assert.equal(cleanPrize('   '), null)
  assert.equal(cleanPrize(null), null)
  assert.equal(cleanPrize('x'.repeat(200)).length, 100)
})

test('the board drops the removed lines', () => {
  const board = renderGameStart({ prize: '500 diamonds' })
  assert.equal(board.includes('I answer'), false)
  assert.equal(board.includes('cannot play this round'), false)
  assert.equal(board.includes('rolled'), false)
  assert.match(board, /- You have \*\*5\*\* guesses each\./)
  assert.match(board, /- Type your guess in this channel\./)
  assert.match(board, /- Prize: \*\*500 diamonds\*\*/)
})

test('no board or win text carries an emoji', () => {
  const emoji = /\p{Extended_Pictographic}/u
  assert.equal(emoji.test(renderGameStart({ prize: 'x' })), false)
  assert.equal(emoji.test(renderWin({
    userId: 'p1',
    game: { secret: 5_000, prize: 'x' },
    result: { used: 2 },
  })), false)
})

test('the prize shows on the board and again to the winner', () => {
  assert.match(renderGameStart({ prize: '500 diamonds' }), /- Prize: \*\*500 diamonds\*\*/)
  assert.match(
    renderWin({ userId: 'p1', game: { secret: 5_000, prize: '500 diamonds' }, result: { used: 2 } }),
    /Prize: \*\*500 diamonds\*\*/,
  )
  assert.equal(renderGameStart({}).includes('Prize'), false)
  assert.equal(
    renderWin({ userId: 'p1', game: { secret: 5_000, prize: null }, result: { used: 2 } }).includes('Prize'),
    false,
  )
})

test('the bot picks a number inside the range when the host sets none', () => {
  const rolled = createGuessGame({
    gameId: GAME_ID,
    channelId: CHANNEL_ID,
    hostId: 'host-1',
    randomImpl: (min, max) => {
      assert.deepEqual([min, max], [1_000, 10_000])
      return 1_234
    },
  })
  assert.equal(rolled.secret, 1_234)
  assert.equal(rolled.hostMayGuess, true)
})

test('a secret outside the range is refused', () => {
  assert.throws(
    () => createGuessGame({ gameId: GAME_ID, channelId: CHANNEL_ID, hostId: 'host-1', secret: 999 }),
    /1000 to 9999/,
  )
})

test('each player gets their own five guesses', () => {
  const active = game({ secret: 5_000 })
  for (let index = 0; index < GUESS_ATTEMPTS; index++) {
    assert.equal(evaluateGuess(active, 'player-1', '4200').status, 'higher')
  }
  assert.deepEqual(
    evaluateGuess(active, 'player-1', '4200'),
    { status: 'eliminated', guess: 4_200, remaining: 0 },
  )
  assert.equal(attemptsLeft(active, 'player-2'), GUESS_ATTEMPTS)
  assert.equal(evaluateGuess(active, 'player-2', '4200').remaining, 4)
})

test('a rejected guess never costs an attempt', () => {
  const active = game({ secret: 5_000 })
  assert.equal(evaluateGuess(active, 'player-1', '42').status, 'out_of_range')
  assert.equal(attemptsLeft(active, 'player-1'), GUESS_ATTEMPTS)
})

test('starting a game posts the board with no button', async () => {
  const { workflow, games } = workflowWith()
  const interaction = commandInteraction()
  const result = await workflow.handleInteraction(interaction)
  assert.equal(result.status, 'started')
  assert.equal(games.get(CHANNEL_ID).secret, 5_000)
  const [payload] = interaction.state.replies
  assert.match(payload.content, /# Game Started/)
  assert.match(payload.content, /between \*\*1000\*\* and \*\*9999\*\*/)
  assert.equal('components' in payload, false)
  assert.equal('embeds' in payload, false)
})

test('the host sets the number and the prize on the board', async () => {
  const { workflow, games } = workflowWith()
  const interaction = commandInteraction({ number: 7_777, prize: '500 diamonds' })
  await workflow.handleInteraction(interaction)
  const stored = games.get(CHANNEL_ID)
  assert.equal(stored.secret, 7_777)
  assert.equal(stored.prize, '500 diamonds')
  assert.equal(stored.hostMayGuess, false)
  assert.match(interaction.state.replies[0].content, /- Prize: \*\*500 diamonds\*\*/)
})

test('a guess is answered with an arrow and nothing else', async () => {
  const { workflow } = workflowWith(game({ secret: 5_000 }))
  const low = guessMessage({ content: '4200' })
  assert.equal((await workflow.handleMessage(low)).status, 'higher')
  assert.deepEqual(low.state.reactions, ['⬆️'])
  assert.deepEqual(low.state.sent, [])

  const high = guessMessage({ content: '8000' })
  assert.equal((await workflow.handleMessage(high)).status, 'lower')
  assert.deepEqual(high.state.reactions, ['⬇️'])
  assert.deepEqual(high.state.sent, [])
})

test('ordinary chat in the channel is left alone', async () => {
  const { workflow } = workflowWith(game())
  for (const content of ['gg wp', '4200 is my lucky number', '42', 'good luck']) {
    const chat = guessMessage({ content })
    assert.equal((await workflow.handleMessage(chat)).status, 'ignored')
    assert.deepEqual(chat.state.reactions, [])
  }
})

test('the bot never answers itself', async () => {
  const { workflow } = workflowWith(game())
  const own = guessMessage({ content: '4200', bot: true })
  assert.equal((await workflow.handleMessage(own)).status, 'ignored')
  assert.deepEqual(own.state.reactions, [])
})

test('a chatting host who set the number is ignored, not answered', async () => {
  const { workflow } = workflowWith(game({ secret: 5_000, hostSet: true }))
  const hostGuess = guessMessage({ userId: 'host-1', content: '5000' })
  const result = await workflow.handleMessage(hostGuess)
  assert.equal(result.status, 'ignored')
  assert.deepEqual(hostGuess.state.reactions, [])
})

test('a player out of guesses gets the stop sign', async () => {
  const running = game({ secret: 5_000 })
  running.attempts.set('player-1', GUESS_ATTEMPTS)
  const { workflow } = workflowWith(running)
  const spent = guessMessage({ content: '4200' })
  assert.equal((await workflow.handleMessage(spent)).status, 'eliminated')
  assert.deepEqual(spent.state.reactions, ['🚫'])
})

test('the winning guess is ticked and announced', async () => {
  const running = game({ secret: 5_000, prize: '500 diamonds' })
  const { workflow } = workflowWith(running)
  const winner = guessMessage({ userId: 'player-7', content: '5000' })
  const result = await workflow.handleMessage(winner)
  assert.equal(result.status, 'won')
  assert.equal(result.winnerId, 'player-7')
  assert.deepEqual(winner.state.reactions, ['✅'])
  assert.match(winner.state.sent[0].content, /# Guessed It/)
  assert.match(winner.state.sent[0].content, /\*\*5000\*\*/)
  assert.match(winner.state.sent[0].content, /Prize: \*\*500 diamonds\*\*/)
})

test('guesses stop counting once the game is won', async () => {
  const finished = game()
  finished.finished = true
  const { workflow } = workflowWith(finished)
  const late = guessMessage({ content: '4200' })
  assert.equal((await workflow.handleMessage(late)).status, 'ignored')
  assert.deepEqual(late.state.reactions, [])
})

test('a channel with no game ignores every number', async () => {
  const { workflow } = workflowWith()
  const stray = guessMessage({ content: '4200' })
  assert.equal((await workflow.handleMessage(stray)).status, 'ignored')
  assert.deepEqual(stray.state.reactions, [])
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
    commandName: 'announce',
  })
  assert.equal(result.status, 'ignored')
})
