import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  NRTSHOP_COMMAND,
  SHOPCONFIG_COMMAND,
  ADMIN_CLAIM_CHANNEL_ID,
  PUBLIC_CLAIM_CHANNEL_ID,
  SHOP_SOURCE_MESSAGE_ID,
  FALLBACK_ITEMS,
  NRT_COIN_EMOJI,
  cleanShopText,
  parseShopItems,
  parseShopParts,
  hasRedeemedMouseOrKeyboard,
  createNrtShopWorkflow,
  renderNrtClaimCard,
  syncNrtPublicClaimNotice,
} from './nrtshop.js'
import { midnightNrtStore } from './midnight-nrt-store.js'

const tempNrtPath = path.join(os.tmpdir(), `midnight-nrt-test-shop-${Date.now()}.json`)
const originalNrtPath = midnightNrtStore.filePath

const tempClaimsPath = path.join(process.cwd(), 'data', 'nrt-claims.json')
let originalClaimsBackup = null

function createShopClient({ sourceMessage, adminSend, publicSend, recentMessages } = {}) {
  const adminChannel = {
    send: adminSend || (async () => ({ id: 'admin-claim-message' })),
  }
  const publicChannel = {
    isTextBased: () => true,
    messages: {
      fetch: async (value) => {
        if (value === SHOP_SOURCE_MESSAGE_ID) return sourceMessage || null
        if (value && typeof value === 'object') return recentMessages || new Map()
        return null
      },
    },
    send: publicSend || (async () => ({ id: 'public-claim-message' })),
  }
  const otherChannel = {
    isTextBased: () => true,
    messages: { fetch: async () => null },
  }
  return {
    user: { id: 'nrt-bot' },
    channels: {
      cache: new Map([
        [ADMIN_CLAIM_CHANNEL_ID, adminChannel],
        [PUBLIC_CLAIM_CHANNEL_ID, publicChannel],
      ]),
      fetch: async (channelId) => {
        if (channelId === ADMIN_CLAIM_CHANNEL_ID) return adminChannel
        if (channelId === PUBLIC_CLAIM_CHANNEL_ID) return publicChannel
        return otherChannel
      },
    },
  }
}

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
  const sourceMessage = {
    content: '📣 **NIGHTRAID TOKEN SHOP**\n⌨️ AULA Mechanical Keyboard\n💰 4,500 NRT — 2 available',
    attachments: new Map(),
  }

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
    client: createShopClient({ sourceMessage }),
  }

  const result = await workflow.handleInteraction(interaction)
  assert.equal(result.status, 'success')
  assert.equal(state.deferred, true)
  assert.equal(state.replies.length, 1) // editReply only
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
  await midnightNrtStore.addNrt('user-rich', 5000)

  const mockMessage = {
    content: '⌨️ AULA Mechanical Keyboard\n💰 4,500 NRT — 1 available',
    components: [
      {
        type: 1, // ActionRow
        components: [
          {
            type: 2, // Button
            style: 3, // Success
            custom_id: 'nrtshop_redeem:item_1:4500',
            label: 'Redeem AULA',
            customId: 'nrtshop_redeem:item_1:4500'
          }
        ]
      }
    ],
    edit: async (payload) => {
      if (payload.components) state.editedMessage = payload
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
    client: createShopClient({ sourceMessage: mockMessage }),
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
  assert.equal(btn.data.label, 'Out of Stock: AULA')
})

test('parseShopItems and parseShopParts replace the broken :emoji_109: emoji with the custom NRT coin emoji', () => {
  const text = '📣 **NIGHTRAID TOKEN SHOP**\n:emoji_109:\nRedeem rewards!'
  const { headerText } = parseShopParts(text)
  assert.ok(!headerText.includes(':emoji_109:'))
  assert.ok(headerText.includes('<:nrt:1538488632388751430>'))
})

test('cleanShopText strips malformed <1538419182993932409> emoji ID from shop text', () => {
  // Case 1: bare <1538419182993932409>
  assert.equal(cleanShopText('SHOP <1538419182993932409>'), 'SHOP ')

  // Case 2: custom emoji format with the wrong ID
  assert.equal(
    cleanShopText('SHOP <:nrt:1538419182993932409>'),
    `SHOP ${NRT_COIN_EMOJI}`,
  )

  // Case 3: header like the real bug: <🪙1538419182993932409>
  const result = cleanShopText('📣 **NIGHTRAID TOKEN SHOP** <🪙1538419182993932409>')
  assert.ok(!result.includes('1538419182993932409'), 'should not contain the broken ID')

  // Case 4: :emoji_109: still works
  assert.equal(
    cleanShopText('test :emoji_109: end'),
    `test ${NRT_COIN_EMOJI} end`,
  )

  // Case 5: already valid emoji is preserved
  assert.equal(
    cleanShopText(`test ${NRT_COIN_EMOJI} end`),
    `test ${NRT_COIN_EMOJI} end`,
  )
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

test('NRT public notices use the claim reference so repeat redemptions get separate messages', async () => {
  const sentPayloads = []
  const client = createShopClient({
    publicSend: async (payload) => {
      sentPayloads.push(payload)
      return { id: `nrt-public-${sentPayloads.length}` }
    },
  })

  const first = await syncNrtPublicClaimNotice(client, {
    winnerId: 'repeat-nrt-user',
    winnerName: '<@repeat-nrt-user>',
    status: 'pending',
    itemName: '200 GCash',
    claimReference: 'nrt-claim-one',
  })
  const second = await syncNrtPublicClaimNotice(client, {
    winnerId: 'repeat-nrt-user',
    winnerName: '<@repeat-nrt-user>',
    status: 'pending',
    itemName: '200 GCash',
    claimReference: 'nrt-claim-two',
  })

  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(sentPayloads.length, 2)
  assert.match(sentPayloads[0].content, /Claim reference: nrt-claim-one/)
  assert.match(sentPayloads[1].content, /Claim reference: nrt-claim-two/)
})

test('NRT redemption reports partial success when the public claim channel rejects the post', async () => {
  const workflow = createNrtShopWorkflow()
  await midnightNrtStore.addNrt('nrt-delivery-user', 5000)
  const sourceMessage = {
    content: '⌨️ AULA Mechanical Keyboard\n💰 4,500 NRT — 1 available',
    components: [],
    edit: async () => {},
  }
  const missingPermission = Object.assign(new Error('Missing Permissions'), { code: 50013, status: 403 })
  let replyPayload
  const result = await workflow.handleInteraction({
    id: 'nrt-delivery-claim',
    isModalSubmit: () => true,
    customId: 'nrtshop_modal:item_1:4500',
    guildId: 'guild-123',
    user: { id: 'nrt-delivery-user' },
    message: sourceMessage,
    fields: {
      getTextInputValue: (field) => field === 'nrt_name'
        ? 'NRT Winner'
        : field === 'nrt_phone' ? '09123456789' : 'Manila',
    },
    client: createShopClient({
      sourceMessage,
      publicSend: async () => { throw missingPermission },
    }),
    reply: async (payload) => { replyPayload = payload },
  })

  assert.equal(result.status, 'partial_success')
  assert.equal(result.publicDelivery.reason, 'public_notice_send_failed')
  assert.equal(await midnightNrtStore.getBalance('nrt-delivery-user'), 500)
  assert.match(replyPayload.content, /redemption was recorded/i)
  assert.match(replyPayload.content, /nrt-delivery-claim/)
  const savedClaims = JSON.parse(fs.readFileSync(tempClaimsPath, 'utf8'))
  assert.equal(savedClaims[0].claimReference, 'nrt-delivery-claim')
})

test('stale NRT redemption prices fail closed without deducting a balance', async () => {
  const workflow = createNrtShopWorkflow()
  await midnightNrtStore.addNrt('stale-price-user', 5000)
  const sourceMessage = {
    content: '⌨️ AULA Mechanical Keyboard\n💰 4,500 NRT — 1 available',
    edit: async () => {},
  }
  let replyPayload
  const result = await workflow.handleInteraction({
    id: 'stale-price-claim',
    isModalSubmit: () => true,
    customId: 'nrtshop_modal:item_1:4000',
    user: { id: 'stale-price-user' },
    fields: { getTextInputValue: () => 'value' },
    client: createShopClient({ sourceMessage }),
    reply: async (payload) => { replyPayload = payload },
  })

  assert.equal(result.status, 'rejected')
  assert.equal(result.reason, 'stale_price')
  assert.equal(await midnightNrtStore.getBalance('stale-price-user'), 5000)
  assert.match(replyPayload.content, /price changed/i)
  assert.equal(fs.existsSync(tempClaimsPath), false)
})

test('NRT claim records fail closed when the persisted JSON is corrupt', () => {
  fs.mkdirSync(path.dirname(tempClaimsPath), { recursive: true })
  fs.writeFileSync(tempClaimsPath, '{not valid json', 'utf8')
  assert.throws(
    () => hasRedeemedMouseOrKeyboard('corrupt-record-user'),
    (error) => error?.code === 'NRT_CLAIM_STORE_FAILED',
  )
})

test('concurrent redemptions are serialized so both persisted claim records survive', async () => {
  const balances = new Map([
    ['concurrent-user-a', 6000],
    ['concurrent-user-b', 6000],
  ])
  const nrtStore = {
    getBalance: async (userId) => balances.get(userId) || 0,
    subtractNrt: async (userId, amount) => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      const next = Math.max(0, (balances.get(userId) || 0) - amount)
      balances.set(userId, next)
      return next
    },
    addNrt: async (userId, amount) => {
      const next = (balances.get(userId) || 0) + amount
      balances.set(userId, next)
      return next
    },
  }
  const workflow = createNrtShopWorkflow({ nrtStore })
  const sourceMessage = {
    content: [
      '⌨️ AULA Mechanical Keyboard',
      '💰 4,500 NRT — 2 available',
      '',
      '🖱️ ATK GEAR DRAGONFLY A9 Mouse',
      '💰 5,000 NRT — 2 available',
    ].join('\n'),
    edit: async (payload) => { sourceMessage.content = payload.content },
  }
  let publicCount = 0
  const client = createShopClient({
    sourceMessage,
    publicSend: async () => ({ id: `concurrent-public-${++publicCount}` }),
  })
  const submission = (userId, itemId, cost) => ({
    id: `claim-${userId}`,
    isModalSubmit: () => true,
    customId: `nrtshop_modal:${itemId}:${cost}`,
    user: { id: userId },
    fields: {
      getTextInputValue: (field) => field === 'nrt_name'
        ? userId
        : field === 'nrt_phone' ? '09123456789' : 'Manila',
    },
    client,
    reply: async () => {},
  })

  const [first, second] = await Promise.all([
    workflow.handleInteraction(submission('concurrent-user-a', 'item_1', 4500)),
    workflow.handleInteraction(submission('concurrent-user-b', 'item_2', 5000)),
  ])

  assert.equal(first.status, 'claimed')
  assert.equal(second.status, 'claimed')
  const savedClaims = JSON.parse(fs.readFileSync(tempClaimsPath, 'utf8'))
  assert.equal(savedClaims.length, 2)
  assert.deepEqual(
    new Set(savedClaims.map((claim) => claim.claimReference)),
    new Set(['claim-concurrent-user-a', 'claim-concurrent-user-b']),
  )
})

test('NRT admin status updates target the exact claim reference after a restart', async () => {
  const claims = [
    {
      claimReference: 'status-claim-one',
      userId: 'status-user',
      name: 'Status User',
      phone: '09123456789',
      address: 'Manila',
      itemId: 'item_4',
      itemName: '200 GCash',
      cost: 2000,
      status: 'pending',
      claimedAt: new Date().toISOString(),
    },
    {
      claimReference: 'status-claim-two',
      userId: 'status-user',
      name: 'Status User',
      phone: '09123456789',
      address: 'Manila',
      itemId: 'item_4',
      itemName: '200 GCash',
      cost: 2000,
      status: 'pending',
      claimedAt: new Date().toISOString(),
    },
  ]
  fs.mkdirSync(path.dirname(tempClaimsPath), { recursive: true })
  fs.writeFileSync(tempClaimsPath, JSON.stringify(claims), 'utf8')

  let firstEdits = 0
  let secondEdits = 0
  const publicNotice = (claimReference, onEdit) => ({
    id: `public-${claimReference}`,
    author: { id: 'nrt-bot' },
    content: [
      '✧ **congratulations nightraid!**',
      '🎉 <@status-user>',
      '💸 ` 200 GCash ` — ` NRT Redeemed `',
      '<:nr_status:1535222637545001082> __Please wait while an admin processes your reward.__',
      `-# Claim reference: ${claimReference}`,
    ].join('\n'),
    edit: async (payload) => onEdit(payload),
  })
  const firstNotice = publicNotice('status-claim-one', () => { firstEdits += 1 })
  const secondNotice = publicNotice('status-claim-two', (payload) => {
    secondEdits += 1
    secondNotice.content = payload.content
  })
  const recentMessages = new Map([
    [firstNotice.id, firstNotice],
    [secondNotice.id, secondNotice],
  ])
  const client = createShopClient({ recentMessages })
  let updatedCard
  const result = await createNrtShopWorkflow().handleInteraction({
    isStringSelectMenu: () => true,
    customId: 'nrtshop_status_select:status-claim-two',
    values: ['done'],
    user: { id: 'admin-user' },
    member: { permissions: { has: () => true } },
    message: {
      content: renderNrtClaimCard({
        userId: 'status-user',
        name: 'Status User',
        phone: '09123456789',
        address: 'Manila',
        itemName: '200 GCash',
        cost: 2000,
        status: 'pending',
        claimedAt: claims[1].claimedAt,
        claimReference: 'status-claim-two',
      }),
    },
    client,
    update: async (payload) => { updatedCard = payload },
  })

  assert.equal(result.status, 'updated')
  assert.equal(firstEdits, 0)
  assert.equal(secondEdits, 1)
  assert.match(secondNotice.content, /processed and sent/i)
  assert.match(updatedCard.content, /Status\*\*: ✅ Done/)
  const updatedClaims = JSON.parse(fs.readFileSync(tempClaimsPath, 'utf8'))
  assert.equal(updatedClaims.find((claim) => claim.claimReference === 'status-claim-one').status, 'pending')
  assert.equal(updatedClaims.find((claim) => claim.claimReference === 'status-claim-two').status, 'done')
})
