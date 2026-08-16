import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  NRTSHOP_COMMAND,
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
