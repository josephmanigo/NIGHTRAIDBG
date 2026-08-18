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
  assert.equal(ADDNRT_COMMAND.name, 'nrtadd')
  assert.equal(MINUSNRT_COMMAND.name, 'minusnrt')
  
  assert.equal(ADDNRT_COMMAND.options[0].name, 'users')
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
    commandName: 'nrtadd',
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
    commandName: 'nrtadd',
    guildId: 'guild-123',
    guild: {
      ownerId: 'owner-123',
      members: {
        fetch: async (id) => ({ user: { id } })
      }
    },
    user: { id: 'founder-user-123' },
    member: memberWithFounder,
    options: {
      getInteger: (name) => name === 'points' ? 10 : null,
      getString: (name) => name === 'users' ? '<@99901>' : null,
      getUser: () => null
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
  interaction.options.getUser = (name) => name === 'user' ? { id: '99901' } : null
  
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
    commandName: 'nrtadd',
    guildId: 'guild-123',
    guild: {
      ownerId: 'owner-123',
      members: {
        fetch: async (id) => ({ user: { id } })
      }
    },
    user: { id: 'owner-123' }, // Matches guild.ownerId
    member: memberWithoutFounder,
    options: {
      getInteger: (name) => name === 'points' ? 5 : null,
      getString: (name) => name === 'users' ? '<@99901>' : null
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

test('addnrt and minusnrt accept multiple users and values in a single call', async () => {
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

  // Mock interaction with multiple options
  const interaction = {
    isChatInputCommand: () => true,
    commandName: 'nrtadd',
    guildId: 'guild-123',
    guild: {
      ownerId: 'owner-123',
      members: {
        fetch: async (id) => ({ user: { id } })
      }
    },
    user: { id: 'founder-123' },
    member: memberWithFounder,
    options: {
      getInteger: (name) => {
        if (name === 'points') return 10
        return null
      },
      getString: (name) => {
        if (name === 'users') return '<@99901> <@99902>'
        return null
      }
    },
    deferReply: async () => {},
    editReply: async (payload) => {
      state.replies.push(payload)
    }
  }

  // 1. Add NRT to multiple users
  const addResult = await addWorkflow.handleInteraction(interaction)
  assert.equal(addResult.status, 'success')
  assert.equal(addResult.entriesCount, 2)
  assert.match(state.replies[0].content, /Added 10.*99901/)
  assert.match(state.replies[0].content, /Added 10.*99902/)

  // 2. Minus NRT from multiple users
  state.replies = []
  interaction.commandName = 'minusnrt'
  interaction.options.getInteger = (name) => {
    if (name === 'points') return 10
    if (name === 'points2') return 20
    return null
  }
  interaction.options.getUser = (name) => {
    if (name === 'user') return { id: 'user-1' }
    if (name === 'user2') return { id: 'user-2' }
    return null
  }

  const minusResult = await minusWorkflow.handleInteraction(interaction)
  assert.equal(minusResult.status, 'success')
  assert.equal(minusResult.entriesCount, 2)
  assert.match(state.replies[0].content, /Subtracted 10.*user-1/)
  assert.match(state.replies[0].content, /Subtracted 20.*user-2/)
})

test('nrtadd accepts up to 20 users, minusnrt accepts up to 10 users', async () => {
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

  // 1. Add NRT to 20 users
  const mentions = Array.from({ length: 20 }, (_, i) => `<@${99901 + i}>`).join(' ')
  const interaction = {
    isChatInputCommand: () => true,
    commandName: 'nrtadd',
    guildId: 'guild-123',
    guild: {
      ownerId: 'owner-123',
      members: {
        fetch: async (id) => ({ user: { id } })
      }
    },
    user: { id: 'founder-123' },
    member: memberWithFounder,
    options: {
      getInteger: (name) => name === 'points' ? 10 : null,
      getString: (name) => name === 'users' ? mentions : null,
    },
    deferReply: async () => {},
    editReply: async (payload) => {
      state.replies.push(payload)
    }
  }

  const addResult = await addWorkflow.handleInteraction(interaction)
  assert.equal(addResult.status, 'success')
  assert.equal(addResult.entriesCount, 20)
  for (let i = 1; i <= 20; i++) {
    assert.match(state.replies[0].content, new RegExp(`Added 10.*${99900 + i}`))
  }

  // 2. Minus NRT from 10 users
  state.replies = []
  interaction.commandName = 'minusnrt'
  interaction.options.getInteger = (name) => {
    if (name === 'points') return 10
    const match = name.match(/^points(\d+)$/)
    if (match) {
      const index = parseInt(match[1], 10)
      if (index >= 2 && index <= 10) return index * 10
    }
    return null
  }
  interaction.options.getUser = (name) => {
    if (name === 'user') return { id: 'user-1' }
    const match = name.match(/^user(\d+)$/)
    if (match) {
      const index = parseInt(match[1], 10)
      if (index >= 2 && index <= 10) return { id: `user-${index}` }
    }
    return null
  }

  const minusResult = await minusWorkflow.handleInteraction(interaction)
  assert.equal(minusResult.status, 'success')
  assert.equal(minusResult.entriesCount, 10)
  for (let i = 1; i <= 10; i++) {
    const expectedPoints = i * 10
    const expectedUserId = `user-${i}`
    assert.match(state.replies[0].content, new RegExp(`Subtracted ${expectedPoints}.*${expectedUserId}`))
  }
})
