import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  TOKENLEADERBOARD_COMMAND,
  createTokenLeaderboardWorkflow,
  renderTokenLeaderboardEmbed,
} from './tokenleaderboard.js'
import { midnightTokenStore } from './midnight-token-store.js'

// Setup temporary file path for tests to avoid modifying production data
const tempStorePath = path.join(os.tmpdir(), `midnight-tokens-test-${Date.now()}.json`)
const originalPath = midnightTokenStore.filePath

test.beforeEach(() => {
  midnightTokenStore.filePath = tempStorePath
  if (fs.existsSync(tempStorePath)) {
    fs.unlinkSync(tempStorePath)
  }
})

test.afterEach(() => {
  midnightTokenStore.filePath = originalPath
  if (fs.existsSync(tempStorePath)) {
    fs.unlinkSync(tempStorePath)
  }
})

test('TOKENLEADERBOARD_COMMAND has correct command structure', () => {
  assert.equal(TOKENLEADERBOARD_COMMAND.name, 'tokenleaderboard')
})

test('renderTokenLeaderboardEmbed renders empty and populated standings without emojis', () => {
  const executor = { id: 'exec-123' }

  // Test empty state
  const emptyEmbed = renderTokenLeaderboardEmbed(executor)
  const emptyData = emptyEmbed.data
  assert.equal(emptyData.title, 'MIDNIGHT LEADERBOARD')
  assert.match(emptyData.description, /No tokens have been awarded yet/)
  assert.match(emptyData.description, /You have 0 tokens/)
  assert.ok(!emptyData.description.includes('🥇'))

  // Populate data
  midnightTokenStore.addToken('user-1', 15)
  midnightTokenStore.addToken('user-2', 8)
  midnightTokenStore.addToken('exec-123', 5)

  // Test populated state
  const populatedEmbed = renderTokenLeaderboardEmbed(executor)
  const populatedData = populatedEmbed.data
  assert.equal(populatedData.title, 'MIDNIGHT LEADERBOARD')
  
  // Emojis should not be in the rankings
  assert.ok(!populatedData.description.includes('🥇'))
  assert.ok(!populatedData.description.includes('🥈'))
  assert.ok(!populatedData.description.includes('🥉'))

  // Check structure and order
  assert.match(populatedData.description, /1\. <@user-1> - 15 tokens/)
  assert.match(populatedData.description, /2\. <@user-2> - 8 tokens/)
  assert.match(populatedData.description, /3\. <@exec-123> - 5 tokens/)
  
  // Executor balance should show 5 tokens
  assert.match(populatedData.description, /You have 5 tokens/)
})

test('createTokenLeaderboardWorkflow handles interaction correctly', async () => {
  const workflow = createTokenLeaderboardWorkflow()
  const state = { replies: [], deferred: false }

  const interaction = {
    isChatInputCommand: () => true,
    commandName: 'tokenleaderboard',
    guildId: 'guild-123',
    user: { id: 'exec-123' },
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
  
  const embed = state.replies[0].embeds[0]
  assert.equal(embed.data.title, 'MIDNIGHT LEADERBOARD')
})
