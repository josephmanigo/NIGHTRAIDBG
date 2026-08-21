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

function guessMessage({
  id = 'guess-message-1',
  userId = 'player-1',
  content = 'nightraid',
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

function workflowWith(existing = null, options = {}) {
  const games = new Map()
  if (existing) games.set(existing.channelId, existing)
  return {
    games,
    workflow: createGuessTheWordWorkflow({ games, gameIdImpl: () => GAME_ID, ...options }),
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

test('matching ignores case, accents, and repeated spaces', () => {
  assert.equal(normalizeWord('  BloodStrike '), 'bloodstrike')
  assert.equal(normalizeWord('Ñoño'), 'nono')
  assert.equal(normalizeWord('  Blood   Stríke  '), 'blood strike')
  const active = game({ word: 'NightRaid' })
  assert.equal(evaluateWordGuess(active, 'p1', 'nightraid').status, 'correct')
  const twoWords = game({ word: 'Blood Strike' })
  assert.equal(evaluateWordGuess(twoWords, 'p2', 'BLOOD   STRÍKE').status, 'correct')
})

test('one or two words count as a guess while longer sentences are chat', () => {
  assert.equal(parseWordGuess('bloodstrike'), 'bloodstrike')
  assert.equal(parseWordGuess("  don't  "), "don't")
  assert.equal(parseWordGuess('night-raid'), 'night-raid')
  assert.equal(parseWordGuess('blood strike'), 'blood strike')
  assert.equal(parseWordGuess('  blood   strike  '), 'blood strike')
  assert.equal(parseWordGuess('is it bloodstrike'), null)
  assert.equal(parseWordGuess(''), null)
  assert.equal(parseWordGuess('https://example.com/x'), null)
  assert.equal(parseWordGuess('x'.repeat(33)), null)
})

test('the secret accepts one or two words and refuses empty or longer answers', () => {
  assert.equal(assertSecretWord(' bloodstrike '), 'bloodstrike')
  assert.equal(assertSecretWord(' blood   strike '), 'blood strike')
  assert.throws(() => assertSecretWord('guess this answer'), /one or two words/)
  assert.throws(() => assertSecretWord(''), /one or two words/)
  assert.throws(() => assertSecretWord('x'.repeat(33)), /one or two words/)
})

test('the board shows the hint', () => {
  const board = renderWordGameStart({ secret: 'bloodstrike', hint: 'The game we play', prize: '500 diamonds' })
  assert.match(board, /# Game Started/)
  assert.match(board, /- Hint: \*\*The game we play\*\*/)
  assert.match(board, /- You have \*\*5\*\* guesses each\./)
  assert.match(board, /Answer format: \*\*1 word\*\*/)
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

test('a two-word game marks both one- and two-word wrong guesses', () => {
  const active = game({ word: 'blood strike' })
  assert.equal(evaluateWordGuess(active, 'player-1', 'bloodstrike').status, 'wrong')
  assert.equal(attemptsLeft(active, 'player-1'), WORD_ATTEMPTS - 1)
  assert.equal(evaluateWordGuess(active, 'player-1', 'wrong answer').status, 'wrong')
  assert.equal(evaluateWordGuess(active, 'player-1', 'blood strike').status, 'correct')
})

test('a one-word wrong reply receives a cross during a two-word game', async () => {
  const { workflow } = workflowWith(game({ word: 'body wash' }))
  const miss = guessMessage({ content: 'sabon' })
  assert.equal((await workflow.handleMessage(miss)).status, 'wrong')
  assert.deepEqual(miss.state.reactions, [WORD_REACTIONS.wrong])
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

test('a two-word answer starts successfully and remains hidden on the board', async () => {
  const { workflow, games } = workflowWith()
  const interaction = commandInteraction({ word: 'blood strike' })
  const result = await workflow.handleInteraction(interaction)
  assert.equal(result.status, 'started')
  assert.equal(games.get(CHANNEL_ID).secret, 'blood strike')
  assert.match(interaction.state.replies[0].content, /Answer format: \*\*2 words\*\*/)
  assert.equal(interaction.state.replies[0].content.includes('blood strike'), false)
})

test('a three-word answer is refused before a game starts', async () => {
  const { workflow, games } = workflowWith()
  const interaction = commandInteraction({ word: 'guess this answer' })
  const result = await workflow.handleInteraction(interaction)
  assert.equal(result.status, 'rejected')
  assert.equal(games.size, 0)
  assert.match(interaction.state.replies[0].content, /one or two words/)
})

test('a wrong guess gets a cross and nothing else', async () => {
  const { workflow } = workflowWith(game())
  const miss = guessMessage({ content: 'valorant' })
  assert.equal((await workflow.handleMessage(miss)).status, 'wrong')
  assert.deepEqual(miss.state.reactions, ['❌'])
  assert.deepEqual(miss.state.sent, [])
})

test('the winning guess is ticked and announced', async () => {
  const { workflow } = workflowWith(game({ word: 'blood strike', prize: '500 diamonds' }))
  const winner = guessMessage({ userId: 'player-7', content: 'BLOOD STRIKE' })
  const result = await workflow.handleMessage(winner)
  assert.equal(result.status, 'won')
  assert.equal(result.winnerId, 'player-7')
  assert.deepEqual(winner.state.reactions, ['✅'])
  assert.match(winner.state.sent[0].content, /# Guessed It/)
  assert.match(winner.state.sent[0].content, /\*\*blood strike\*\*/)
  assert.match(winner.state.sent[0].content, /Prize: \*\*500 diamonds\*\*/)
})

test('a word-game winner receives one 50 NRT award and the win message confirms it', async () => {
  const awardCalls = []
  const { workflow } = workflowWith(game({ word: 'blood strike' }), {
    onWinner: async (context) => {
      awardCalls.push(context)
      return { status: 'awarded', amount: 50, balance: 150 }
    },
  })
  const winner = guessMessage({ id: 'word-winning-message', userId: 'player-50', content: 'blood strike' })
  const result = await workflow.handleMessage(winner)

  assert.equal(result.nrtAward.status, 'awarded')
  assert.equal(awardCalls.length, 1)
  assert.equal(awardCalls[0].gameType, 'word')
  assert.equal(awardCalls[0].sourceMessageId, 'word-winning-message')
  assert.equal(awardCalls[0].userId, 'player-50')
  assert.match(winner.state.sent[0].content, /NRT Reward: \*\*\+50 NRT\*\*/)

  const replay = await workflow.handleMessage(winner)
  assert.equal(replay.status, 'ignored')
  assert.equal(awardCalls.length, 1)
})

test('a word-game win stays final and reports honestly if the NRT callback fails', async () => {
  const errors = []
  const { workflow } = workflowWith(game(), {
    onWinner: async () => { throw new Error('database offline') },
    errorReporter: { report: (...args) => errors.push(args) },
  })
  const winner = guessMessage({ id: 'word-failed-award', content: 'bloodstrike' })
  const result = await workflow.handleMessage(winner)
  assert.equal(result.status, 'won')
  assert.equal(result.nrtAward.status, 'error')
  assert.match(winner.state.sent[0].content, /could not be confirmed/)
  assert.equal(errors[0][0], 'guess_the_word_nrt_award')
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
