import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  NRTLEADERBOARD_COMMAND,
  createNrtLeaderboardWorkflow,
  renderNrtLeaderboardEmbed,
} from './nrtleaderboard.js'
import { midnightNrtStore } from './midnight-nrt-store.js'

// Setup temporary file path for tests to avoid modifying production data
const tempStorePath = path.join(os.tmpdir(), `midnight-nrt-test-${Date.now()}.json`)
const originalPath = midnightNrtStore.filePath

test.beforeEach(() => {
  midnightNrtStore.filePath = tempStorePath
  if (fs.existsSync(tempStorePath)) {
    fs.unlinkSync(tempStorePath)
  }
})

test.afterEach(() => {
  midnightNrtStore.filePath = originalPath
  if (fs.existsSync(tempStorePath)) {
    fs.unlinkSync(tempStorePath)
  }
})

test('NRTLEADERBOARD_COMMAND has correct command structure', () => {
  assert.equal(NRTLEADERBOARD_COMMAND.name, 'nrtleaderboard')
})

test('renderNrtLeaderboardEmbed renders empty and populated standings without emojis', async () => {
  const executor = { id: 'exec-123' }

  // Test empty state
  const emptyEmbed = await renderNrtLeaderboardEmbed(executor)
  const emptyData = emptyEmbed.data
  assert.equal(emptyData.title, 'NIGHTRAID TOKEN LEADERBOARD')
  assert.match(emptyData.description, /No NRT has been awarded yet/)
  assert.match(emptyData.description, /You have 0 NRT/)
  assert.ok(!emptyData.description.includes('🥇'))

  // Populate data
  midnightNrtStore.addNrt('user-1', 15)
  midnightNrtStore.addNrt('user-2', 8)
  midnightNrtStore.addNrt('exec-123', 5)

  // Test populated state
  const populatedEmbed = await renderNrtLeaderboardEmbed(executor)
  const populatedData = populatedEmbed.data
  assert.equal(populatedData.title, 'NIGHTRAID TOKEN LEADERBOARD')
  
  // Emojis should not be in the rankings
  assert.ok(!populatedData.description.includes('🥇'))
  assert.ok(!populatedData.description.includes('🥈'))
  assert.ok(!populatedData.description.includes('🥉'))

  // Check structure and order
  assert.match(populatedData.description, /1\. <@user-1> - 15 NRT/)
  assert.match(populatedData.description, /2\. <@user-2> - 8 NRT/)
  assert.match(populatedData.description, /3\. <@exec-123> - 5 NRT/)
  
  // Executor balance should show 5 NRT
  assert.match(populatedData.description, /You have 5 NRT/)
})

test('createNrtLeaderboardWorkflow handles interaction correctly', async () => {
  const workflow = createNrtLeaderboardWorkflow()
  const state = { replies: [], deferred: false }

  const interaction = {
    isChatInputCommand: () => true,
    commandName: 'nrtleaderboard',
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
  assert.equal(embed.data.title, 'NIGHTRAID TOKEN LEADERBOARD')
})
