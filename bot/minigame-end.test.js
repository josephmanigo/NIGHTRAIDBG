import assert from 'node:assert/strict'
import test from 'node:test'
import { END_GAME_COMMAND, createEndGameWorkflow } from './minigame-end.js'
import { createGuessTheNumberWorkflow } from './guess-the-number.js'
import { createGuessTheWordWorkflow } from './guess-the-word.js'

const CHANNEL_ID = '1208605026868535387'

function endInteraction({ userId = 'host-1', administrator = false } = {}) {
  const state = { replies: [] }
  return {
    state,
    isChatInputCommand: () => true,
    commandName: END_GAME_COMMAND.name,
    guildId: 'guild-1',
    channelId: CHANNEL_ID,
    user: { id: userId },
    member: { permissions: { has: () => administrator } },
    reply: async (payload) => {
      state.replies.push(payload)
    },
    editReply: async (payload) => {
      state.replies.push(payload)
    },
  }
}

function startInteraction({ command, userId = 'host-1', values = {} }) {
  return {
    isChatInputCommand: () => true,
    commandName: command,
    guildId: 'guild-1',
    channelId: CHANNEL_ID,
    user: { id: userId },
    member: { permissions: { has: () => false } },
    options: {
      getInteger: (name) => values[name] ?? null,
      getString: (name) => values[name] ?? null,
    },
    reply: async () => undefined,
    editReply: async () => undefined,
    fetchReply: async () => ({ id: 'game-msg' }),
  }
}

async function runningGames({ number = {}, word = {}, hostId = 'host-1' } = {}) {
  const numberWorkflow = createGuessTheNumberWorkflow({ randomImpl: () => 5_000 })
  const wordWorkflow = createGuessTheWordWorkflow()
  await numberWorkflow.handleInteraction(startInteraction({
    command: 'guessthenumber',
    userId: hostId,
    values: { number: 7_777, ...number },
  }))
  await wordWorkflow.handleInteraction(startInteraction({
    command: 'guesstheword',
    userId: hostId,
    values: { word: 'bloodstrike', hint: 'The game we play', ...word },
  }))
  return {
    numberWorkflow,
    wordWorkflow,
    endWorkflow: createEndGameWorkflow({ workflows: [numberWorkflow, wordWorkflow] }),
  }
}

test('the command takes no options', () => {
  assert.equal(END_GAME_COMMAND.name, 'endgame')
  assert.equal('options' in END_GAME_COMMAND, false)
})

test('the host ends both games and both answers are revealed', async () => {
  const { endWorkflow, numberWorkflow, wordWorkflow } = await runningGames()
  const interaction = endInteraction({ userId: 'host-1' })
  const result = await endWorkflow.handleInteraction(interaction)
  assert.deepEqual(result, { status: 'ended', games: ['number', 'word'] })

  const [payload] = interaction.state.replies
  assert.match(payload.content, /# Game Over/)
  assert.match(payload.content, /the number was \*\*7777\*\*/i)
  assert.match(payload.content, /the word was \*\*bloodstrike\*\*/i)
  assert.match(payload.content, /Ended by <@host-1>/)
  /* Both games are closed, so late guesses stop counting. */
  assert.equal(numberWorkflow.games.get(CHANNEL_ID).finished, true)
  assert.equal(wordWorkflow.games.get(CHANNEL_ID).finished, true)
})

test('the unclaimed prize is named', async () => {
  const { endWorkflow } = await runningGames({
    number: { prize: '500 diamonds' },
    word: { prize: '500 diamonds' },
  })
  const interaction = endInteraction({ userId: 'host-1' })
  await endWorkflow.handleInteraction(interaction)
  assert.match(interaction.state.replies[0].content, /Nobody won \*\*500 diamonds\*\*/)
})

test('a bystander cannot end somebody else\'s game', async () => {
  const { endWorkflow, numberWorkflow } = await runningGames()
  const interaction = endInteraction({ userId: 'player-9' })
  const result = await endWorkflow.handleInteraction(interaction)
  assert.equal(result.status, 'unauthorized')
  assert.match(interaction.state.replies[0].content, /Only <@host-1> or an administrator/)
  assert.equal(numberWorkflow.games.get(CHANNEL_ID).finished, false)
})

test('an administrator can end a game they did not start', async () => {
  const { endWorkflow } = await runningGames()
  const interaction = endInteraction({ userId: 'admin-1', administrator: true })
  assert.equal((await endWorkflow.handleInteraction(interaction)).status, 'ended')
})

test('ending only the game that is running is fine', async () => {
  const numberWorkflow = createGuessTheNumberWorkflow({ randomImpl: () => 5_000 })
  const wordWorkflow = createGuessTheWordWorkflow()
  await numberWorkflow.handleInteraction(startInteraction({
    command: 'guessthenumber',
    values: { number: 7_777 },
  }))
  const endWorkflow = createEndGameWorkflow({ workflows: [numberWorkflow, wordWorkflow] })
  const interaction = endInteraction()
  const result = await endWorkflow.handleInteraction(interaction)
  assert.deepEqual(result.games, ['number'])
  assert.equal(interaction.state.replies[0].content.includes('word was'), false)
})

test('an empty channel says so, quietly', async () => {
  const endWorkflow = createEndGameWorkflow({
    workflows: [createGuessTheNumberWorkflow(), createGuessTheWordWorkflow()],
  })
  const interaction = endInteraction()
  const result = await endWorkflow.handleInteraction(interaction)
  assert.equal(result.status, 'none')
  assert.match(interaction.state.replies[0].content, /No guessing game is running/)
  assert.equal(interaction.state.replies[0].flags, 64)
})

test('ending twice reports nothing left to end', async () => {
  const { endWorkflow } = await runningGames()
  await endWorkflow.handleInteraction(endInteraction())
  const second = endInteraction()
  assert.equal((await endWorkflow.handleInteraction(second)).status, 'none')
})

test('other commands are ignored', async () => {
  const endWorkflow = createEndGameWorkflow({ workflows: [] })
  const result = await endWorkflow.handleInteraction({
    isChatInputCommand: () => true,
    commandName: 'announce',
  })
  assert.equal(result.status, 'ignored')
})
