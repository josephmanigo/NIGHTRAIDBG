import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  NRTSHOP_COMMAND,
  SHOPCONFIG_COMMAND,
  FALLBACK_ITEMS,
  parseShopItems,
  parseShopParts,
  hasRedeemedMouseOrKeyboard,
  createNrtShopWorkflow,
} from './nrtshop.js'
import { midnightNrtStore } from './midnight-nrt-store.js'

const tempNrtPath = path.join(os.tmpdir(), `midnight-nrt-test-shop-${Date.now()}.json`)
const originalNrtPath = midnightNrtStore.filePath

const tempClaimsPath = path.join(process.cwd(), 'data', 'nrt-claims.json')
let originalClaimsBackup = null

test.before(() => {
  if (fs.existsSync(tempClaimsPath)) {
    originalClaimsBackup = fs.readFileSync(tempClaimsPath)
    fs.unlinkSync(tempClaimsPath)
  }
})

test.after(() => {
  if (originalClaimsBackup) {
    fs.writeFileSync(tempClaimsPath, originalClaimsBackup)
  } else if (fs.existsSync(tempClaimsPath)) {
    fs.unlinkSync(tempClaimsPath)
  }
})

test.beforeEach(() => {
  midnightNrtStore.filePath = tempNrtPath
  if (fs.existsSync(tempNrtPath)) {
    fs.unlinkSync(tempNrtPath)
  }
  if (fs.existsSync(tempClaimsPath)) {
    fs.unlinkSync(tempClaimsPath)
  }
})

test.afterEach(() => {
  midnightNrtStore.filePath = originalNrtPath
  if (fs.existsSync(tempNrtPath)) {
    fs.unlinkSync(tempNrtPath)
  }
  if (fs.existsSync(tempClaimsPath)) {
    fs.unlinkSync(tempClaimsPath)
  }
})

test('NRTSHOP_COMMAND has correct command structure', () => {
  assert.equal(NRTSHOP_COMMAND.name, 'nrtshop')
})

test('parseShopItems parses raw shop message correctly', () => {
  const sampleText = `
    📣 **NIGHTRAID TOKEN SHOP** 🪙
    Redeem your hard-earned NRT for exclusive rewards:

    ⌨️ AULA Mechanical Keyboard
    💰 4,500 NRT — 2 available

    🖱️ ATK GEAR DRAGONFLY A9 Mouse
    💰 5,000 NRT — 2 available

    🥇 200 GCash
    💰 2,000 NRT — 5 available
  `

  const items = parseShopItems(sampleText)
  assert.equal(items.length, 3)

  assert.equal(items[0].label, 'AULA Mechanical Keyboard')
  assert.equal(items[0].cost, 4500)
  assert.equal(items[0].emoji, '⌨️')

  assert.equal(items[1].label, 'ATK GEAR DRAGONFLY A9 Mouse')
  assert.equal(items[1].cost, 5000)
  assert.equal(items[1].emoji, '🖱️')

  assert.equal(items[2].label, '200 GCash')
  assert.equal(items[2].cost, 2000)
  assert.equal(items[2].emoji, '🥇')
})

test('parseShopParts splits raw shop message into header, items, and footer correctly', () => {
  const sampleText = `
    📣 **NIGHTRAID TOKEN SHOP** 🪙
    Redeem your hard-earned NRT for exclusive rewards:

    ⌨️ AULA Mechanical Keyboard
    💰 4,500 NRT — 2 available

    🖱️ ATK GEAR DRAGONFLY A9 Mouse
    💰 5,000 NRT — 2 available

    ⚠️ Limited stock - Each person can redeem either the mouse or the keyboard, but not both.
    EARN. RAID. REDEEM.
  `

  const { headerText, footerText, items } = parseShopParts(sampleText)
  assert.equal(items.length, 2)
  assert.match(headerText, /NIGHTRAID TOKEN SHOP/)
  assert.match(headerText, /Redeem your hard-earned NRT/)
  assert.match(footerText, /Limited stock/)
  assert.match(footerText, /EARN. RAID. REDEEM/)
})

test('parseShopItems falls back correctly on null or empty content', () => {
  const items = parseShopItems(null)
  assert.deepEqual(items, FALLBACK_ITEMS)
})

test('hasRedeemedMouseOrKeyboard correctly detects mouse and keyboard redemption records', () => {
  const userId = 'test-user-123'
  assert.equal(hasRedeemedMouseOrKeyboard(userId), false)

  // Save a mock claim
  const mockClaim = {
    userId,
    itemName: 'AULA Mechanical Keyboard',
    status: 'pending',
  }
  fs.writeFileSync(tempClaimsPath, JSON.stringify([mockClaim]))

  assert.equal(hasRedeemedMouseOrKeyboard(userId), true)
})

test('createNrtShopWorkflow handleInteraction dispatches command correctly', async () => {
  const workflow = createNrtShopWorkflow()
  const state = { replies: [], deferred: false }

  const interaction = {
    isChatInputCommand: () => true,
    commandName: 'nrtshop',
    guildId: 'guild-123',
    user: { id: 'user-123' },
    deferReply: async () => {
      state.deferred = true
    },
    editReply: async (payload) => {
      state.replies.push(payload)
    },
    reply: async (payload) => {
      state.replies.push(payload)
    },
    followUp: async (payload) => {
      state.replies.push(payload)
    },
    client: {
      channels: {
        cache: new Map(),
      },
    },
  }

  const result = await workflow.handleInteraction(interaction)
  assert.equal(result.status, 'success')
  assert.equal(state.deferred, true)
  assert.equal(state.replies.length, 7) // 1 header + 5 items + 1 footer
  assert.match(state.replies[0].content, /NIGHTRAID TOKEN SHOP/)
})

test('createNrtShopWorkflow handleInteraction checks NRT balance on redeem button click', async () => {
  const workflow = createNrtShopWorkflow()
  const state = { replies: [] }

  const interaction = {
    isButton: () => true,
    customId: 'nrtshop_redeem:item_1:4500',
    guildId: 'guild-123',
    user: { id: 'user-poor' },
    reply: async (payload) => {
      state.replies.push(payload)
    },
    client: {
      channels: {
        cache: new Map(),
      },
    },
  }

  // Poor user has 0 balance, should be rejected
  const result = await workflow.handleInteraction(interaction)
  assert.equal(result.status, 'rejected')
  assert.equal(result.reason, 'insufficient_balance')
  assert.match(state.replies[0].content, /You need at least 4,500 NRT/)
})

test('modal submission decrements available stock in real time and disables button when out of stock', async () => {
  const workflow = createNrtShopWorkflow()
  const state = { replies: [], editedMessage: null }

  // Set up user with enough NRT balance (e.g. 5000 NRT)
  midnightNrtStore.addNrt('user-rich', 5000)

  const mockMessage = {
    content: '⌨️ AULA Mechanical Keyboard\n💰 4,500 NRT — 1 available',
    components: [
      {
        components: [
          { customId: 'nrtshop_redeem:item_1:4500', label: 'Redeem' }
        ]
      }
    ],
    edit: async (payload) => {
      state.editedMessage = payload
    }
  }

  const interaction = {
    isModalSubmit: () => true,
    customId: 'nrtshop_modal:item_1:4500',
    guildId: 'guild-123',
    user: { id: 'user-rich' },
    message: mockMessage,
    fields: {
      getTextInputValue: (id) => {
        if (id === 'nrt_name') return 'John Doe'
        if (id === 'nrt_phone') return '12345678'
        if (id === 'nrt_address') return 'Manila'
        return null
      }
    },
    reply: async (payload) => {
      state.replies.push(payload)
    },
    client: {
      channels: {
        cache: new Map([
          ['1345711473476898896', { send: async () => {} }],
          ['1535215403834544158', { send: async () => {}, messages: { fetch: async () => null } }]
        ]),
        fetch: async () => ({ send: async () => {}, messages: { fetch: async () => null } })
      },
    },
  }

  const result = await workflow.handleInteraction(interaction)
  assert.equal(result.status, 'claimed')

  // Verify message content was edited to decrement stock
  assert.ok(state.editedMessage)
  assert.match(state.editedMessage.content, /0 available/)

  // Verify button was disabled
  const actionRow = state.editedMessage.components[0]
  const btn = actionRow.components[0]
  assert.equal(btn.data.disabled, true)
  assert.equal(btn.data.label, 'Out of Stock')
})

test('parseShopItems and parseShopParts replace the broken :emoji_109: emoji with the custom NRT coin emoji', () => {
  const text = '📣 **NIGHTRAID TOKEN SHOP**\n:emoji_109:\nRedeem rewards!'
  const { headerText } = parseShopParts(text)
  assert.ok(!headerText.includes(':emoji_109:'))
  assert.ok(headerText.includes('<:nrt:1538488632388751430>'))
})

test('SHOPCONFIG_COMMAND has correct command structure', () => {
  assert.equal(SHOPCONFIG_COMMAND.name, 'shopconfig')
  assert.equal(SHOPCONFIG_COMMAND.options[0].name, 'action')
  assert.equal(SHOPCONFIG_COMMAND.options[1].name, 'name')
})

test('createNrtShopWorkflow handleInteraction handles shopconfig command actions', async () => {
  const workflow = createNrtShopWorkflow()
  const state = { replies: [], editedMessage: null }

  // 1. Mock source message on the client
  const mockSourceMessage = {
    content: '📣 **NIGHTRAID TOKEN SHOP** <:nrt:1538488632388751430>\nRedeem your hard-earned NRT:\n\n⌨️ AULA Keyboard\n💰 4,500 NRT — 2 available\n\n⚠️ Footer',
    edit: async (payload) => {
      state.editedMessage = payload
    }
  }

  const clientMock = {
    channels: {
      cache: new Map(),
      fetch: async () => ({
        isTextBased: () => true,
        messages: {
          fetch: async () => mockSourceMessage
        }
      })
    }
  }

  // 2. Set up interaction options helper
  let currentAction = 'add'
  let currentCost = 6000
  let currentAvailability = 3
  let currentName = 'New Gaming Chair'

  const memberAdmin = {
    permissions: {
      has: () => true
    }
  }

  const interaction = {
    isChatInputCommand: () => true,
    commandName: 'shopconfig',
    guildId: 'guild-123',
    member: memberAdmin,
    options: {
      getString: (name) => {
        if (name === 'action') return currentAction
        if (name === 'name') return currentName
        if (name === 'emoji') return '💺'
        return null
      },
      getInteger: (name) => {
        if (name === 'cost') return currentCost
        if (name === 'availability') return currentAvailability
        return null
      }
    },
    deferReply: async () => {},
    editReply: async (payload) => {
      state.replies.push(payload)
    },
    client: clientMock
  }

  // 3. Test ADD item
  const addResult = await workflow.handleInteraction(interaction)
  assert.equal(addResult.status, 'success')
  assert.equal(addResult.action, 'add')
  assert.equal(addResult.name, 'New Gaming Chair')

  // Verify the edited source message text contains the new item
  assert.ok(state.editedMessage.content.includes('New Gaming Chair'))
  assert.ok(state.editedMessage.content.includes('💺'))
  assert.ok(state.editedMessage.content.includes('6,000 NRT — 3 available'))

  // 4. Test UPDATE item
  state.editedMessage = null
  currentAction = 'update'
  currentName = 'AULA Keyboard'
  currentCost = 4000
  currentAvailability = 5

  const updateResult = await workflow.handleInteraction(interaction)
  assert.equal(updateResult.status, 'success')
  assert.equal(updateResult.action, 'update')
  assert.equal(updateResult.name, 'AULA Keyboard')
  assert.ok(state.editedMessage.content.includes('AULA Keyboard'))
  assert.ok(state.editedMessage.content.includes('4,000 NRT — 5 available'))

  // 5. Test REMOVE item
  state.editedMessage = null
  currentAction = 'remove'
  currentName = 'AULA Keyboard'

  const removeResult = await workflow.handleInteraction(interaction)
  assert.equal(removeResult.status, 'success')
  assert.equal(removeResult.action, 'remove')
  assert.equal(removeResult.name, 'AULA Keyboard')
  assert.ok(!state.editedMessage.content.includes('AULA Keyboard'))
})
