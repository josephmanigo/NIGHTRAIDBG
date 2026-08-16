import assert from 'node:assert/strict'
import test from 'node:test'
import { PermissionFlagsBits } from 'discord.js'
import {
  CLEAR_GUESSING_GAME_COMMAND,
  createClearGuessingGameWorkflow,
  partitionMessagesByAge,
  fetchChannelWinnerMessages,
} from './clearguessinggame.js'
import { DEFAULT_WINNER_CHANNEL_ID } from './winner.js'

test('CLEAR_GUESSING_GAME_COMMAND has correct command structure', () => {
  assert.equal(CLEAR_GUESSING_GAME_COMMAND.name, 'clearguessinggame')
  assert.equal(CLEAR_GUESSING_GAME_COMMAND.defaultMemberPermissions, PermissionFlagsBits.Administrator)
  assert.equal(CLEAR_GUESSING_GAME_COMMAND.options.length, 1)
  assert.equal(CLEAR_GUESSING_GAME_COMMAND.options[0].name, 'channel')
})

test('partitionMessagesByAge splits messages based on 14 days age', () => {
  const now = Date.now()
  const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000

  const messages = [
    {
      id: 'm1',
      createdTimestamp: now - (5 * 24 * 60 * 60 * 1000), // 5 days old (new)
    },
    {
      id: 'm2',
      createdTimestamp: now - (15 * 24 * 60 * 60 * 1000), // 15 days old (old)
    },
    {
      id: 'm3',
      createdAt: new Date(now - (1 * 24 * 60 * 60 * 1000)), // 1 day old (new, using createdAt)
    },
    {
      id: 'm4',
      createdAt: new Date(now - (20 * 24 * 60 * 60 * 1000)), // 20 days old (old, using createdAt)
    },
  ]

  const { bulkDeletable, individuallyDeletable } = partitionMessagesByAge(messages, now)

  assert.equal(bulkDeletable.length, 2)
  assert.equal(bulkDeletable[0].id, 'm1')
  assert.equal(bulkDeletable[1].id, 'm3')

  assert.equal(individuallyDeletable.length, 2)
  assert.equal(individuallyDeletable[0].id, 'm2')
  assert.equal(individuallyDeletable[1].id, 'm4')
})

test('fetchChannelWinnerMessages returns only winner announcement messages', async () => {
  const now = Date.now()
  const channel = {
    messages: {
      fetch: async () => {
        return new Map([
          [
            'm1',
            {
              id: 'm1',
              createdTimestamp: now,
              content: '# Guessed It\n<@1001> found the word: **TEST**.\n-# Won with 1 guess.',
            },
          ],
          [
            'm2',
            {
              id: 'm2',
              createdTimestamp: now,
              content: 'Regular chat message, not a winner announcement.',
            },
          ],
          [
            'm3',
            {
              id: 'm3',
              createdTimestamp: now,
              content: '# Guessed It\n<@1002> found the number: **42**.\n-# Won with 3 guesses.',
            },
          ],
        ])
      },
    },
  }

  const winnerMessages = await fetchChannelWinnerMessages(channel, 100)
  assert.equal(winnerMessages.length, 2)
  assert.equal(winnerMessages[0].id, 'm1')
  assert.equal(winnerMessages[1].id, 'm3')
})

test('createClearGuessingGameWorkflow clears no messages when none exist', async () => {
  const workflow = createClearGuessingGameWorkflow({ defaultChannelId: DEFAULT_WINNER_CHANNEL_ID })
  const state = { replies: [], deferred: false }

  const channel = {
    id: DEFAULT_WINNER_CHANNEL_ID,
    messages: {
      fetch: async () => new Map(),
    },
  }

  const interaction = {
    isChatInputCommand: () => true,
    commandName: 'clearguessinggame',
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
  }

  const result = await workflow.handleInteraction(interaction)
  assert.equal(result.status, 'success')
  assert.equal(result.deletedCount, 0)
  assert.equal(state.deferred, true)
  assert.equal(state.replies.length, 1)
  assert.match(state.replies[0].content, /No guessing game winner announcements found to clear/)
})

test('createClearGuessingGameWorkflow deletes messages (both bulk and individual)', async () => {
  const workflow = createClearGuessingGameWorkflow({ defaultChannelId: DEFAULT_WINNER_CHANNEL_ID })
  const state = { replies: [], deferred: false }

  let bulkDeletedList = []
  let individualDeletedList = []

  const now = Date.now()

  const channel = {
    id: DEFAULT_WINNER_CHANNEL_ID,
    messages: {
      fetch: async () => {
        return new Map([
          [
            'm1',
            {
              id: 'm1',
              createdTimestamp: now - (5 * 24 * 60 * 60 * 1000), // 5 days old (new)
              content: '# Guessed It\n<@1001> found the word: **TEST**.\n-# Won with 1 guess.',
            },
          ],
          [
            'm2',
            {
              id: 'm2',
              createdTimestamp: now - (6 * 24 * 60 * 60 * 1000), // 6 days old (new)
              content: '# Guessed It\n<@1001> found the word: **TEST2**.\n-# Won with 2 guesses.',
            },
          ],
          [
            'm3',
            {
              id: 'm3',
              createdTimestamp: now - (20 * 24 * 60 * 60 * 1000), // 20 days old (old)
              content: '# Guessed It\n<@1002> found the number: **42**.\n-# Won with 3 guesses.',
              delete: async function() {
                individualDeletedList.push(this.id)
              },
            },
          ],
        ])
      },
    },
    bulkDelete: async (messages) => {
      bulkDeletedList = messages.map(m => m.id)
      return { size: messages.length }
    },
  }

  const interaction = {
    isChatInputCommand: () => true,
    commandName: 'clearguessinggame',
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
  }

  const result = await workflow.handleInteraction(interaction)
  assert.equal(result.status, 'success')
  assert.equal(result.deletedCount, 3)

  // Verify m1 and m2 were bulk deleted
  assert.equal(bulkDeletedList.length, 2)
  assert.ok(bulkDeletedList.includes('m1'))
  assert.ok(bulkDeletedList.includes('m2'))

  // Verify m3 was individually deleted
  assert.equal(individualDeletedList.length, 1)
  assert.ok(individualDeletedList.includes('m3'))

  assert.equal(state.replies.length, 1)
  assert.match(state.replies[0].content, /Successfully cleared the leaderboard by deleting \*\*3\*\* winner announcement/)
})
