import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { ADDNRT_COMMAND, createAddNrtWorkflow } from './addnrt.js'
import { MINUSNRT_COMMAND, createMinusNrtWorkflow } from './minusnrt.js'
import { midnightNrtStore } from './midnight-nrt-store.js'

// Setup temporary file path for tests to avoid modifying production data
const tempStorePath = path.join(os.tmpdir(), `midnight-nrt-test-actions-${Date.now()}.json`)
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

test('ADDNRT_COMMAND and MINUSNRT_COMMAND have correct command structures', () => {
  assert.equal(ADDNRT_COMMAND.name, 'addnrt')
  assert.equal(MINUSNRT_COMMAND.name, 'minusnrt')
  
  assert.equal(ADDNRT_COMMAND.options[0].name, 'user')
  assert.equal(ADDNRT_COMMAND.options[1].name, 'points')
  assert.equal(MINUSNRT_COMMAND.options[0].name, 'user')
  assert.equal(MINUSNRT_COMMAND.options[1].name, 'points')
})

test('addnrt and minusnrt reject non-Founder / non-Owner users', async () => {
  const addWorkflow = createAddNrtWorkflow()
  const minusWorkflow = createMinusNrtWorkflow()
  
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
    commandName: 'addnrt',
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

  // Test addnrt rejection
  let result = await addWorkflow.handleInteraction(interaction)
  assert.equal(result.status, 'rejected')
  assert.equal(result.reason, 'not_founder')
  assert.match(state.replies[0].content, /Only the Founder can use this command/)

  // Test minusnrt rejection
  state.replies = []
  interaction.commandName = 'minusnrt'
  result = await minusWorkflow.handleInteraction(interaction)
  assert.equal(result.status, 'rejected')
  assert.equal(result.reason, 'not_founder')
  assert.match(state.replies[0].content, /Only the Founder can use this command/)
})

test('addnrt and minusnrt accept user with Founder role', async () => {
  const addWorkflow = createAddNrtWorkflow()
  const minusWorkflow = createMinusNrtWorkflow()
  
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
    commandName: 'addnrt',
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

  // 1. Add 10 NRT
  let result = await addWorkflow.handleInteraction(interaction)
  assert.equal(result.status, 'success')
  assert.equal(result.newBalance, 10)
  assert.match(state.replies[0].content, /Added 10/)

  // 2. Subtract 4 NRT
  state.replies = []
  state.deferred = false
  interaction.commandName = 'minusnrt'
  interaction.options.getInteger = (name) => name === 'points' ? 4 : null
  
  result = await minusWorkflow.handleInteraction(interaction)
  assert.equal(result.status, 'success')
  assert.equal(result.newBalance, 6)
  assert.match(state.replies[0].content, /Subtracted 4/)

  // 3. Subtract 10 NRT (should clamp to 0)
  state.replies = []
  state.deferred = false
  interaction.options.getInteger = (name) => name === 'points' ? 10 : null
  
  result = await minusWorkflow.handleInteraction(interaction)
  assert.equal(result.status, 'success')
  assert.equal(result.newBalance, 0)
  assert.match(state.replies[0].content, /Subtracted 10.*0 NRT/)
})

test('addnrt and minusnrt accept user who is server Owner even without Founder role', async () => {
  const addWorkflow = createAddNrtWorkflow()
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
    commandName: 'addnrt',
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
