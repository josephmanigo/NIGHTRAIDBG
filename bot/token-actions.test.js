import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { ADDTOKEN_COMMAND, createAddTokenWorkflow } from './addtoken.js'
import { MINUSTOKEN_COMMAND, createMinusTokenWorkflow } from './minustoken.js'
import { midnightTokenStore } from './midnight-token-store.js'

// Setup temporary file path for tests to avoid modifying production data
const tempStorePath = path.join(os.tmpdir(), `midnight-tokens-test-actions-${Date.now()}.json`)
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

test('ADDTOKEN_COMMAND and MINUSTOKEN_COMMAND have correct command structures', () => {
  assert.equal(ADDTOKEN_COMMAND.name, 'addtoken')
  assert.equal(MINUSTOKEN_COMMAND.name, 'minustoken')
  
  assert.equal(ADDTOKEN_COMMAND.options[0].name, 'user')
  assert.equal(ADDTOKEN_COMMAND.options[1].name, 'points')
  assert.equal(MINUSTOKEN_COMMAND.options[0].name, 'user')
  assert.equal(MINUSTOKEN_COMMAND.options[1].name, 'points')
})

test('addtoken and minustoken reject non-Founder / non-Owner users', async () => {
  const addWorkflow = createAddTokenWorkflow()
  const minusWorkflow = createMinusTokenWorkflow()
  
  const state = { replies: [], deferred: false }
  const memberWithoutFounder = {
    roles: {
      cache: {
        some: (fn) => fn({ name: 'Admin' }) // does not have "Founder"
      }
    }
  }

  const interaction = {
    isChatInputCommand: () => true,
    commandName: 'addtoken',
    guildId: 'guild-123',
    guild: { ownerId: 'owner-123' },
    user: { id: 'non-founder-123' },
    member: memberWithoutFounder,
    deferReply: async () => {
      state.deferred = true
    },
    reply: async (payload) => {
      state.replies.push(payload)
    },
    editReply: async (payload) => {
      state.replies.push(payload)
    }
  }

  // Test addtoken rejection
  let result = await addWorkflow.handleInteraction(interaction)
  assert.equal(result.status, 'rejected')
  assert.equal(result.reason, 'not_founder')
  assert.match(state.replies[0].content, /Only the Founder can use this command/)

  // Test minustoken rejection
  state.replies = []
  interaction.commandName = 'minustoken'
  result = await minusWorkflow.handleInteraction(interaction)
  assert.equal(result.status, 'rejected')
  assert.equal(result.reason, 'not_founder')
  assert.match(state.replies[0].content, /Only the Founder can use this command/)
})

test('addtoken and minustoken accept user with Founder role', async () => {
  const addWorkflow = createAddTokenWorkflow()
  const minusWorkflow = createMinusTokenWorkflow()
  
  const state = { replies: [], deferred: false }
  const memberWithFounder = {
    roles: {
      cache: {
        some: (fn) => fn({ name: 'Founder' })
      }
    }
  }

  const interaction = {
    isChatInputCommand: () => true,
    commandName: 'addtoken',
    guildId: 'guild-123',
    guild: { ownerId: 'owner-123' },
    user: { id: 'founder-user-123' },
    member: memberWithFounder,
    options: {
      getInteger: (name) => name === 'points' ? 10 : null,
      getUser: (name) => name === 'user' ? { id: 'target-user' } : null
    },
    deferReply: async () => {
      state.deferred = true
    },
    reply: async (payload) => {
      state.replies.push(payload)
    },
    editReply: async (payload) => {
      state.replies.push(payload)
    }
  }

  // 1. Add 10 tokens
  let result = await addWorkflow.handleInteraction(interaction)
  assert.equal(result.status, 'success')
  assert.equal(result.newBalance, 10)
  assert.match(state.replies[0].content, /Added 10/)

  // 2. Subtract 4 tokens
  state.replies = []
  state.deferred = false
  interaction.commandName = 'minustoken'
  interaction.options.getInteger = (name) => name === 'points' ? 4 : null
  
  result = await minusWorkflow.handleInteraction(interaction)
  assert.equal(result.status, 'success')
  assert.equal(result.newBalance, 6)
  assert.match(state.replies[0].content, /Subtracted 4/)

  // 3. Subtract 10 tokens (should clamp to 0)
  state.replies = []
  state.deferred = false
  interaction.options.getInteger = (name) => name === 'points' ? 10 : null
  
  result = await minusWorkflow.handleInteraction(interaction)
  assert.equal(result.status, 'success')
  assert.equal(result.newBalance, 0)
  assert.match(state.replies[0].content, /Subtracted 10.*0 tokens/)
})

test('addtoken and minustoken accept user who is server Owner even without Founder role', async () => {
  const addWorkflow = createAddTokenWorkflow()
  const state = { replies: [], deferred: false }
  
  // Owner has no roles cache or doesn't have "Founder"
  const memberWithoutFounder = {
    roles: {
      cache: {
        some: () => false
      }
    }
  }

  const interaction = {
    isChatInputCommand: () => true,
    commandName: 'addtoken',
    guildId: 'guild-123',
    guild: { ownerId: 'owner-123' },
    user: { id: 'owner-123' }, // Matches guild.ownerId
    member: memberWithoutFounder,
    options: {
      getInteger: (name) => name === 'points' ? 5 : null,
      getUser: (name) => name === 'user' ? { id: 'target-user' } : null
    },
    deferReply: async () => {
      state.deferred = true
    },
    reply: async (payload) => {
      state.replies.push(payload)
    },
    editReply: async (payload) => {
      state.replies.push(payload)
    }
  }

  const result = await addWorkflow.handleInteraction(interaction)
  assert.equal(result.status, 'success')
  assert.equal(result.newBalance, 5)
  assert.match(state.replies[0].content, /Added 5/)
})
