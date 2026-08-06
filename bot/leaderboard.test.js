import assert from 'node:assert/strict'
import test from 'node:test'
import {
  LEADERBOARD_COMMAND,
  createLeaderboardWorkflow,
  fetchChannelLeaderboard,
  parseLeaderboardFromMessages,
  renderLeaderboard,
} from './leaderboard.js'
import { DEFAULT_WINNER_CHANNEL_ID } from './winner.js'

test('LEADERBOARD_COMMAND has correct command structure', () => {
  assert.equal(LEADERBOARD_COMMAND.name, 'leaderboard')
  assert.equal(LEADERBOARD_COMMAND.options.length, 1)
  assert.equal(LEADERBOARD_COMMAND.options[0].name, 'channel')
})

test('parseLeaderboardFromMessages aggregates win counts, game types, and orders by wins and timestamp', () => {
  const now = Date.now()
  const messages = [
    {
      id: 'm1',
      createdTimestamp: now - 3000,
      content: '# Guessed It\n<@1001> found the word: **ALPHA**.\nPrize: **100 Gold**\n-# Won with 2 guesses.',
    },
    {
      id: 'm2',
      createdTimestamp: now - 2000,
      content: '# Guessed It\n<@1002> found the number: **50**.\n-# Won with 1 guess.',
    },
    {
      id: 'm3',
      createdTimestamp: now - 1000,
      content: '# Guessed It\n<@1001> found the number: **100**.\n-# Won with 3 guesses.',
    },
    {
      id: 'm4',
      createdTimestamp: now - 500,
      content: '# Guessed It\n<@1003> found the word: **BRAVO**.\n-# Won with 4 guesses.',
    },
    {
      id: 'm5',
      createdTimestamp: now,
      content: 'Just a regular conversation message in the channel.',
    },
  ]

  const leaderboard = parseLeaderboardFromMessages(messages)
  assert.equal(leaderboard.length, 3)

  // Top player: user 1001 with 2 wins (1 word, 1 number)
  assert.equal(leaderboard[0].userId, '1001')
  assert.equal(leaderboard[0].totalWins, 2)
  assert.equal(leaderboard[0].wordWins, 1)
  assert.equal(leaderboard[0].numberWins, 1)

  // Tied at 1 win: user 1003 won more recently (now - 500) than user 1002 (now - 2000)
  assert.equal(leaderboard[1].userId, '1003')
  assert.equal(leaderboard[1].totalWins, 1)
  assert.equal(leaderboard[1].wordWins, 1)
  assert.equal(leaderboard[1].numberWins, 0)

  assert.equal(leaderboard[2].userId, '1002')
  assert.equal(leaderboard[2].totalWins, 1)
  assert.equal(leaderboard[2].wordWins, 0)
  assert.equal(leaderboard[2].numberWins, 1)
})

test('renderLeaderboard formats empty and populated leaderboard', () => {
  const emptyText = renderLeaderboard({
    leaderboard: [],
    targetChannelId: DEFAULT_WINNER_CHANNEL_ID,
  })
  assert.match(emptyText, /No minigame winners recorded in this channel yet/)

  const populatedText = renderLeaderboard({
    leaderboard: [
      { userId: '1001', totalWins: 3, wordWins: 2, numberWins: 1, latestWinTimestamp: Date.now() },
      { userId: '1002', totalWins: 2, wordWins: 2, numberWins: 0, latestWinTimestamp: Date.now() - 100 },
      { userId: '1003', totalWins: 1, wordWins: 0, numberWins: 1, latestWinTimestamp: Date.now() - 200 },
      { userId: '1004', totalWins: 1, wordWins: 1, numberWins: 0, latestWinTimestamp: Date.now() - 300 },
    ],
    targetChannelId: DEFAULT_WINNER_CHANNEL_ID,
    limit: 10,
  })

  assert.match(populatedText, /# Minigame Winner Leaderboard/)
  assert.match(populatedText, /🥇 <@1001> — \*\*3 wins\*\* \(2 Word, 1 Number\)/)
  assert.match(populatedText, /🥈 <@1002> — \*\*2 wins\*\* \(2 Word\)/)
  assert.match(populatedText, /🥉 <@1003> — \*\*1 win\*\* \(1 Number\)/)
  assert.match(populatedText, /4\. <@1004> — \*\*1 win\*\* \(1 Word\)/)
  assert.match(populatedText, /Total wins recorded: \*\*7\*\* across \*\*4\*\* unique players/)
})

test('fetchChannelLeaderboard fetches pages and parses messages', async () => {
  let callCount = 0
  const channel = {
    messages: {
      fetch: async (options) => {
        callCount++
        if (options.before) {
          return new Map() // end of pages
        }
        return new Map([
          [
            'm1',
            {
              id: 'm1',
              createdTimestamp: Date.now(),
              content: '# Guessed It\n<@999> found the word: **WINNER**.',
            },
          ],
        ])
      },
    },
  }

  const leaderboard = await fetchChannelLeaderboard(channel, { fetchLimit: 200 })
  assert.equal(leaderboard.length, 1)
  assert.equal(leaderboard[0].userId, '999')
  assert.ok(callCount >= 1)
})

test('createLeaderboardWorkflow handles interaction correctly', async () => {
  const workflow = createLeaderboardWorkflow({ defaultChannelId: DEFAULT_WINNER_CHANNEL_ID })
  const state = { replies: [], deferred: false }

  const channel = {
    id: DEFAULT_WINNER_CHANNEL_ID,
    messages: {
      fetch: async () => new Map(),
    },
  }

  const interaction = {
    isChatInputCommand: () => true,
    commandName: 'leaderboard',
    guildId: 'guild-123',
    channelId: DEFAULT_WINNER_CHANNEL_ID,
    channel,
    options: {
      getChannel: () => null,
    },
    deferReply: async () => {
      state.deferred = true
    },
    editReply: async (payload) => {
      state.replies.push(payload)
    },
    reply: async (payload) => {
      state.replies.push(payload)
    },
  }

  const result = await workflow.handleInteraction(interaction)
  assert.equal(result.status, 'success')
  assert.equal(state.deferred, true)
  assert.equal(state.replies.length, 1)
  assert.match(state.replies[0].content, /No minigame winners recorded in this channel yet/)
})
