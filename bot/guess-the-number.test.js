import assert from 'node:assert/strict'
import test from 'node:test'
import {
  GUESS_ATTEMPTS,
  GUESS_MAXIMUM,
  GUESS_MINIMUM,
  GUESS_THE_NUMBER_COMMAND,
  attemptsLeft,
  cleanPrize,
  createGuessGame,
  createGuessTheNumberWorkflow,
  evaluateGuess,
  parseGuessButtonId,
  parseGuessModalId,
  parseGuessValue,
  renderGameStart,
  renderGuessResult,
  renderWin,
} from './guess-the-number.js'

const CHANNEL_ID = '1208605026868535387'
const GAME_ID = 'a1b2c3d4'

function game({ secret = 5_000, hostId = 'host-1', hostSet = false } = {}) {
  return createGuessGame({
    gameId: GAME_ID,
    channelId: CHANNEL_ID,
    guildId: 'guild-1',
    hostId,
    secret: hostSet ? secret : null,
    randomImpl: () => secret,
  })
}

function commandInteraction({
  userId = 'host-1',
  number = null,
  prize = null,
  administrator = false,
} = {}) {
  const state = { replies: [], modal: null, edits: [] }
  const reply = {
    id: 'game-msg',
    edit: async (payload) => {
      state.edits.push(payload)
    },
  }
  return {
    state,
    isChatInputCommand: () => true,
    isButton: () => false,
    isModalSubmit: () => false,
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
    fetchReply: async () => reply,
  }
}

function modalInteraction({ userId = 'player-1', guess = '5000', gameId = GAME_ID } = {}) {
  const state = { replies: [] }
  return {
    state,
    isChatInputCommand: () => false,
    isButton: () => false,
    isModalSubmit: () => true,
    customId: `nr-gtn:submit:${gameId}`,
    guildId: 'guild-1',
    channelId: CHANNEL_ID,
    user: { id: userId },
    fields: { getTextInputValue: () => guess },
    reply: async (payload) => {
      state.replies.push(payload)
    },
    editReply: async (payload) => {
      state.replies.push(payload)
    },
  }
}

function buttonInteraction({ userId = 'player-1', gameId = GAME_ID } = {}) {
  const state = { replies: [], modal: null }
  return {
    state,
    isChatInputCommand: () => false,
    isButton: () => true,
    isModalSubmit: () => false,
    customId: `nr-gtn:guess:${gameId}`,
    guildId: 'guild-1',
    channelId: CHANNEL_ID,
    user: { id: userId },
    showModal: async (view) => {
      state.modal = view
    },
    reply: async (payload) => {
      state.replies.push(payload)
    },
    editReply: async (payload) => {
      state.replies.push(payload)
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

test('the prize is flattened to one harmless line', () => {
  assert.equal(cleanPrize('  500  diamonds '), '500 diamonds')
  assert.equal(cleanPrize('a\nb`c`'), 'a b c')
  assert.equal(cleanPrize('   '), null)
  assert.equal(cleanPrize(null), null)
  assert.equal(cleanPrize('x'.repeat(200)).length, 100)
})

test('nothing the game posts carries an emoji', () => {
  const emoji = /\p{Extended_Pictographic}/u
  const started = renderGameStart({ hostId: 'h1', hostChoseSecret: true, prize: 'x' })
  assert.equal(emoji.test(started), false)
  assert.equal(emoji.test(renderGuessResult({
    userId: 'p1',
    result: { status: 'lower', guess: 8_000, remaining: 2 },
  })), false)
  assert.equal(emoji.test(renderWin({
    userId: 'p1',
    game: { secret: 5_000, prize: 'x' },
    result: { used: 2 },
  })), false)
})

test('the board never says the bot rolled the number', () => {
  assert.equal(
    renderGameStart({ hostId: 'h1', hostChoseSecret: false }).includes('rolled'),
    false,
  )
})

test('the prize shows on the board and again to the winner', () => {
  assert.match(
    renderGameStart({ hostId: 'h1', hostChoseSecret: false, prize: '500 diamonds' }),
    /- Prize: \*\*500 diamonds\*\*/,
  )
  assert.match(
    renderWin({ userId: 'p1', game: { secret: 5_000, prize: '500 diamonds' }, result: { used: 2 } }),
    /Prize: \*\*500 diamonds\*\*/,
  )
  /* No prize set, no prize line anywhere. */
  assert.equal(
    renderGameStart({ hostId: 'h1', hostChoseSecret: false }).includes('Prize'),
    false,
  )
  assert.equal(
    renderWin({ userId: 'p1', game: { secret: 5_000, prize: null }, result: { used: 2 } }).includes('Prize'),
    false,
  )
})

test('the range is fixed at 1000 to 9999 with five guesses each', () => {
  assert.equal(GUESS_MINIMUM, 1_000)
  assert.equal(GUESS_MAXIMUM, 9_999)
  assert.equal(GUESS_ATTEMPTS, 5)
})

test('only whole numbers inside the range parse as a guess', () => {
  assert.equal(parseGuessValue('4200'), 4_200)
  assert.equal(parseGuessValue(' 4,200 '), 4_200)
  assert.equal(parseGuessValue('999'), null)
  assert.equal(parseGuessValue('10000'), null)
  assert.equal(parseGuessValue('42.5'), null)
  assert.equal(parseGuessValue('-4200'), null)
  assert.equal(parseGuessValue('abcd'), null)
})

test('custom ids round-trip and reject foreign ids', () => {
  assert.deepEqual(parseGuessButtonId(`nr-gtn:guess:${GAME_ID}`), { gameId: GAME_ID })
  assert.deepEqual(parseGuessModalId(`nr-gtn:submit:${GAME_ID}`), { gameId: GAME_ID })
  assert.equal(parseGuessButtonId(`nr-gtn:submit:${GAME_ID}`), null)
  assert.equal(parseGuessModalId('nr-announce:compose:1:none'), null)
  assert.equal(parseGuessButtonId('nr-gtn:guess:XYZ'), null)
})

test('the bot rolls a number inside the range when the host sets none', () => {
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

test('a host who set the number cannot guess it', () => {
  const hosted = game({ secret: 5_000, hostSet: true })
  assert.equal(hosted.hostMayGuess, false)
  assert.deepEqual(evaluateGuess(hosted, 'host-1', '5000'), { status: 'host_locked' })
  assert.equal(hosted.finished, false)
})

test('a secret outside the range is refused', () => {
  assert.throws(
    () => createGuessGame({ gameId: GAME_ID, channelId: CHANNEL_ID, hostId: 'host-1', secret: 999 }),
    /1000 to 9999/,
  )
})

test('guesses answer higher or lower and count down', () => {
  const active = game({ secret: 5_000 })
  assert.deepEqual(
    evaluateGuess(active, 'player-1', '4200'),
    { status: 'higher', guess: 4_200, remaining: 4, used: 1 },
  )
  assert.deepEqual(
    evaluateGuess(active, 'player-1', '8000'),
    { status: 'lower', guess: 8_000, remaining: 3, used: 2 },
  )
  assert.equal(attemptsLeft(active, 'player-1'), 3)
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
  /* A second player is untouched by the first player's run. */
  assert.equal(attemptsLeft(active, 'player-2'), GUESS_ATTEMPTS)
  assert.equal(evaluateGuess(active, 'player-2', '4200').remaining, 4)
})

test('a rejected guess never costs an attempt', () => {
  const active = game({ secret: 5_000 })
  assert.equal(evaluateGuess(active, 'player-1', '42').status, 'out_of_range')
  assert.equal(evaluateGuess(active, 'player-1', 'nope').status, 'out_of_range')
  assert.equal(attemptsLeft(active, 'player-1'), GUESS_ATTEMPTS)
})

test('the exact number wins and closes the game', () => {
  const active = game({ secret: 5_000 })
  const result = evaluateGuess(active, 'player-1', '5000')
  assert.deepEqual(result, { status: 'correct', guess: 5_000, remaining: 4, used: 1 })
  assert.equal(active.finished, true)
  assert.equal(active.winnerId, 'player-1')
  assert.deepEqual(evaluateGuess(active, 'player-2', '5000'), { status: 'finished' })
})

test('the hint names the direction and the guesses left', () => {
  assert.equal(
    renderGuessResult({ userId: 'p1', result: { status: 'higher', guess: 4_200, remaining: 3 } }),
    '<@p1> guessed **4200** — go **HIGHER**. 3 guesses left.',
  )
  assert.equal(
    renderGuessResult({ userId: 'p1', result: { status: 'lower', guess: 8_000, remaining: 1 } }),
    '<@p1> guessed **8000** — go **LOWER**. 1 guess left.',
  )
})

test('starting a game posts the board with a Guess button', async () => {
  const { workflow, games } = workflowWith()
  const interaction = commandInteraction()
  const result = await workflow.handleInteraction(interaction)
  assert.equal(result.status, 'started')
  assert.equal(games.get(CHANNEL_ID).secret, 5_000)
  const [payload] = interaction.state.replies
  assert.match(payload.content, /# Game Started/)
  assert.match(payload.content, /\*\*How To Play:\*\*/)
  assert.match(payload.content, /between \*\*1000\*\* and \*\*9999\*\*/)
  assert.match(payload.content, /\*\*5\*\* guesses each/)
  /* Plain Markdown, never an embed: the rest of the bot answers the same way. */
  assert.equal('embeds' in payload, false)
  assert.equal(payload.components[0].components[0].data.custom_id, `nr-gtn:guess:${GAME_ID}`)
})

test('the host sets the number and the prize on the board', async () => {
  const { workflow, games } = workflowWith()
  const interaction = commandInteraction({ number: 7_777, prize: '500 diamonds' })
  await workflow.handleInteraction(interaction)
  const stored = games.get(CHANNEL_ID)
  assert.equal(stored.secret, 7_777)
  assert.equal(stored.prize, '500 diamonds')
  /* Choosing the number locks the host out of guessing it. */
  assert.equal(stored.hostMayGuess, false)
  assert.match(interaction.state.replies[0].content, /- Prize: \*\*500 diamonds\*\*/)
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

test('the Guess button opens the modal, but not for a spent player', async () => {
  const running = game()
  const { workflow } = workflowWith(running)
  const opened = buttonInteraction({ userId: 'player-1' })
  assert.equal((await workflow.handleInteraction(opened)).status, 'guessing')
  assert.equal(opened.state.modal.data.custom_id, `nr-gtn:submit:${GAME_ID}`)

  running.attempts.set('player-1', GUESS_ATTEMPTS)
  const spent = buttonInteraction({ userId: 'player-1' })
  assert.equal((await workflow.handleInteraction(spent)).status, 'rejected')
  assert.equal(spent.state.modal, null)
  assert.match(spent.state.replies[0].content, /all 5 of your guesses/)
})

test('submitting a wrong guess answers publicly with the hint', async () => {
  const { workflow } = workflowWith(game({ secret: 5_000 }))
  const interaction = modalInteraction({ guess: '4200' })
  const result = await workflow.handleInteraction(interaction)
  assert.equal(result.status, 'higher')
  assert.equal(result.remaining, 4)
  assert.match(interaction.state.replies[0].content, /go \*\*HIGHER\*\*\. 4 guesses left/)
  assert.equal('flags' in interaction.state.replies[0], false)
})

test('submitting the right guess announces the winner and closes the board', async () => {
  const running = game({ secret: 5_000 })
  const edits = []
  running.message = { edit: async (payload) => edits.push(payload) }
  const { workflow } = workflowWith(running)
  const interaction = modalInteraction({ guess: '5000', userId: 'player-7' })
  const result = await workflow.handleInteraction(interaction)
  assert.equal(result.status, 'won')
  assert.equal(result.winnerId, 'player-7')
  assert.match(interaction.state.replies[0].content, /# Guessed It/)
  assert.match(interaction.state.replies[0].content, /\*\*5000\*\*/)
  assert.equal(edits[0].components[0].components[0].data.disabled, true)
})

test('a guess for a finished game is turned away', async () => {
  const finished = game()
  finished.finished = true
  const { workflow } = workflowWith(finished)
  const interaction = modalInteraction()
  const result = await workflow.handleInteraction(interaction)
  assert.equal(result.status, 'rejected')
  assert.match(interaction.state.replies[0].content, /already ended/)
})

test('other interactions are ignored', async () => {
  const { workflow } = workflowWith()
  const result = await workflow.handleInteraction({
    isChatInputCommand: () => true,
    commandName: 'announce',
    isButton: () => false,
    isModalSubmit: () => false,
  })
  assert.equal(result.status, 'ignored')
})
