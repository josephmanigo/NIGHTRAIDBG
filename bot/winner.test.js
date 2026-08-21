import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  CLAIM_PRIZE_TTL_MS,
  DEFAULT_ADMIN_CLAIM_CHANNEL_ID,
  DEFAULT_PUBLIC_CLAIM_CHANNEL_ID,
  DEFAULT_PUBLIC_CLAIM_EMOJI_ID,
  DEFAULT_PUBLIC_CLAIM_MESSAGE_ID,
  DEFAULT_WINNER_CHANNEL_ID,
  WINNER_COMMAND,
  createClaimPrizeButton,
  createClaimStatusSelectMenu,
  createWinnerWorkflow,
  extractPrizeFromText,
  fetchChannelWinners,
  formatPublicNoticePrize,
  isSameDay,
  parseWinnerFromMessage,
  renderClaimCard,
  renderPublicClaimNotice,
  renderWinnersList,
  scheduleClaimButtonExpiration,
} from './winner.js'
import { WinnerClaimStore } from './winner-claim-store.js'

function createTestWinnerWorkflow(options = {}) {
  return createWinnerWorkflow({
    ...options,
    claimStore: options.claimStore || new WinnerClaimStore(null),
  })
}

test('WINNER_COMMAND has the correct command structure and default channel IDs', () => {
  assert.equal(WINNER_COMMAND.name, 'winner')
  assert.equal(DEFAULT_WINNER_CHANNEL_ID, '1534862469367992321')
  assert.equal(DEFAULT_ADMIN_CLAIM_CHANNEL_ID, '1345711473476898896')
  assert.equal(DEFAULT_PUBLIC_CLAIM_CHANNEL_ID, '1535215403834544158')
  assert.equal(DEFAULT_PUBLIC_CLAIM_MESSAGE_ID, '1535223055914246185')
  assert.equal(DEFAULT_PUBLIC_CLAIM_EMOJI_ID, '1535222637545001082')
  assert.equal(WINNER_COMMAND.options.length, 1)
  assert.equal(WINNER_COMMAND.options[0].name, 'channel')
})

test('claim button carries a 24-hour deadline and automatically becomes expired', async () => {
  const now = 1_800_000_000_000
  const expiresAt = now + CLAIM_PRIZE_TTL_MS
  const active = createClaimPrizeButton({ expiresAt })
  const activeButton = active.components[0].data

  assert.equal(activeButton.custom_id, `claim_winner_prize:${expiresAt}`)
  assert.equal(activeButton.label, 'Claim Prize (24h)')
  assert.equal(activeButton.disabled, false)

  let timerCallback = null
  let editedPayload = null
  const message = {
    id: 'claim-message-timer',
    edit: async (payload) => { editedPayload = payload },
  }
  scheduleClaimButtonExpiration(message, expiresAt, {
    now: () => now,
    setTimer: (callback, delay) => {
      assert.equal(delay, CLAIM_PRIZE_TTL_MS)
      timerCallback = callback
      return { unref: () => {} }
    },
  })
  timerCallback()
  await new Promise((resolve) => setImmediate(resolve))

  const expiredButton = editedPayload.components[0].components[0].data
  assert.equal(expiredButton.label, 'Claim Expired')
  assert.equal(expiredButton.disabled, true)
})

test('expired prize button refuses the claim and disables itself', async () => {
  const now = 1_800_000_000_000
  const workflow = createTestWinnerWorkflow({ now: () => now })
  let replyPayload = null
  let editedPayload = null
  const interaction = {
    id: 'expired-button-interaction',
    isButton: () => true,
    customId: `claim_winner_prize:${now - 1}`,
    user: { id: 'winner-expired' },
    message: {
      id: 'expired-source-message',
      content: '<@winner-expired>',
      edit: async (payload) => { editedPayload = payload },
    },
    reply: async (payload) => { replyPayload = payload },
  }

  const result = await workflow.handleInteraction(interaction)

  assert.equal(result.status, 'rejected')
  assert.equal(result.reason, 'expired')
  assert.match(replyPayload.content, /expired after 24 hours/i)
  assert.equal(editedPayload.components[0].components[0].data.disabled, true)
})

test('isSameDay correctly identifies dates on the same day', () => {
  const today = new Date('2026-08-06T14:30:00Z')
  const sameDayLater = new Date('2026-08-06T23:59:59Z')
  const nextDay = new Date('2026-08-07T00:01:00Z')

  assert.equal(isSameDay(sameDayLater.getTime(), today), true)
  assert.equal(isSameDay(nextDay.getTime(), today), false)
})

test('parseWinnerFromMessage extracts word game winner details', () => {
  const message = {
    id: 'msg-1',
    channelId: DEFAULT_WINNER_CHANNEL_ID,
    createdTimestamp: Date.now(),
    content: [
      '# Guessed It',
      '<@1234567890> found the word: **BLOODSTRIKE**.',
      'Prize: **500 Gold**',
      '-# Won with 3 guesses.',
    ].join('\n'),
  }

  const result = parseWinnerFromMessage(message)
  assert.notEqual(result, null)
  assert.equal(result.userId, '1234567890')
  assert.equal(result.gameType, 'word')
  assert.equal(result.secret, 'BLOODSTRIKE')
  assert.equal(result.prize, '500 Gold')
  assert.equal(result.tries, '3 guesses')
})

test('parseWinnerFromMessage extracts number game winner details without prize', () => {
  const message = {
    id: 'msg-2',
    channelId: DEFAULT_WINNER_CHANNEL_ID,
    createdTimestamp: Date.now(),
    content: [
      '# Guessed It',
      '<@9876543210> found the number: **4200**.',
      '-# Won with 1 guess.',
    ].join('\n'),
  }

  const result = parseWinnerFromMessage(message)
  assert.notEqual(result, null)
  assert.equal(result.userId, '9876543210')
  assert.equal(result.gameType, 'number')
  assert.equal(result.secret, '4200')
  assert.equal(result.prize, null)
  assert.equal(result.tries, '1 guess')
})

test('parseWinnerFromMessage returns null for non-win messages', () => {
  const message = {
    content: 'Hello everyone! Good game!',
  }
  assert.equal(parseWinnerFromMessage(message), null)
})

test('renderWinnersList formats empty state and populated state', () => {
  const date = new Date('2026-08-06T12:00:00Z')

  const emptyText = renderWinnersList({
    winners: [],
    targetChannelId: DEFAULT_WINNER_CHANNEL_ID,
    date,
  })
  assert.match(emptyText, /No guessing game winners recorded today yet/)

  const populatedText = renderWinnersList({
    winners: [
      {
        userId: '111111',
        gameType: 'word',
        secret: 'VICTORY',
        prize: 'VIP Role',
        tries: '2 guesses',
        timestamp: new Date('2026-08-06T10:15:00Z').getTime(),
      },
    ],
    targetChannelId: DEFAULT_WINNER_CHANNEL_ID,
    date,
  })

  assert.match(populatedText, /Today's Winners/)
  assert.match(populatedText, /<@111111>/)
  assert.match(populatedText, /Word: VICTORY/)
  assert.match(populatedText, /VIP Role/)
  assert.match(populatedText, /Total winners today: \*\*1\*\*/)
})

test('renderClaimCard formats claim details card correctly', () => {
  const card = renderClaimCard({
    winnerId: '999888',
    name: 'Mayen',
    gcash: '09123456789',
    uid: 'UID999',
    status: 'pending',
    handledBy: null,
  })

  assert.match(card, /💖 <@999888>/)
  assert.match(card, /Full Name\*\*: Mayen/)
  assert.match(card, /GCash Number\*\*: 09123456789/)
  assert.match(card, /In-Game UID\*\*: UID999/)
  assert.match(card, /Status\*\*: ⏳ Pending/)
  assert.match(card, /Handled by\*\* — None yet/)
})

test('extractPrizeFromText extracts prize from announcement text or game win messages', () => {
  const text1 = 'CONGRATS @NIGHT • yepo IKAW ANG MASWERTENG MAGWAWAGI NG 50 GCASH NGAYONG ARAW'
  assert.equal(extractPrizeFromText(text1), '50 GCash')
  assert.equal(formatPublicNoticePrize(extractPrizeFromText(text1)), 'P50')

  const text2 = 'CONGRATS @user IKAW ANG MAGWAWAGI NG 100 GCASH'
  assert.equal(extractPrizeFromText(text2), '100 GCash')
  assert.equal(formatPublicNoticePrize(extractPrizeFromText(text2)), 'P100')

  const text3 = 'Prize: **50 GCash**'
  assert.equal(extractPrizeFromText(text3), '50 GCash')

  const text4 = '💸 **Prize**: 50 GCash'
  assert.equal(extractPrizeFromText(text4), '50 GCash')

  const text5 = '💸 **Prize**: VIP Role'
  assert.equal(extractPrizeFromText(text5), 'VIP Role')
})

test('formatPublicNoticePrize formats 50 GCash, 100 GCash, 200 GCash dynamically', () => {
  assert.equal(formatPublicNoticePrize('50 GCash'), 'P50')
  assert.equal(formatPublicNoticePrize('50'), 'P50')
  assert.equal(formatPublicNoticePrize('P50'), 'P50')
  assert.equal(formatPublicNoticePrize('100 GCash'), 'P100')
  assert.equal(formatPublicNoticePrize('100'), 'P100')
  assert.equal(formatPublicNoticePrize('200 GCash'), 'P200')
  assert.equal(formatPublicNoticePrize(null), 'P100')
})

test('renderPublicClaimNotice formats notice using custom emoji 1535222637545001082 and space line after via gcash', () => {
  const pendingNotice = renderPublicClaimNotice({
    winnerId: '999888',
    winnerName: 'Mayen',
    dateStr: 'aug 8 2026',
    status: 'pending',
    prize: '50 GCash',
  })
  assert.match(pendingNotice, /congratulations nightraid!/)
  assert.match(pendingNotice, /Mayen/)
  assert.match(pendingNotice, /aug 8 2026/)
  assert.match(pendingNotice, /P50/)
  assert.match(pendingNotice, /via gcash/)
  assert.match(pendingNotice, /1535222637545001082/)
  assert.match(pendingNotice, /via gcash `\n\n<:nr_status:1535222637545001082>/)
  assert.match(pendingNotice, /__Please wait while an admin processes your reward.__/)
  assert.equal(pendingNotice.includes('<u>'), false)

  const doneNotice = renderPublicClaimNotice({
    winnerId: '999888',
    status: 'done',
  })
  assert.match(doneNotice, /__Your reward has been processed and sent!__/)
})

test('fetchChannelWinners filters messages by today and sorts chronologically', async () => {
  const today = new Date('2026-08-06T12:00:00Z')
  const todayTime1 = new Date('2026-08-06T09:00:00Z').getTime()
  const todayTime2 = new Date('2026-08-06T11:00:00Z').getTime()
  const yesterdayTime = new Date('2026-08-05T15:00:00Z').getTime()

  const messagesMap = new Map([
    [
      'm2',
      {
        id: 'm2',
        createdTimestamp: todayTime2,
        content: '# Guessed It\n<@200000000000000002> found the word: **SECOND**.\n-# Won with 2 guesses.',
      },
    ],
    [
      'm1',
      {
        id: 'm1',
        createdTimestamp: todayTime1,
        content: '# Guessed It\n<@100000000000000001> found the number: **1000**.\n-# Won with 1 guess.',
      },
    ],
    [
      'old',
      {
        id: 'old',
        createdTimestamp: yesterdayTime,
        content: '# Guessed It\n<@300000000000000003> found the word: **YESTERDAY**.\n-# Won with 1 guess.',
      },
    ],
  ])

  const channel = {
    messages: {
      fetch: async () => messagesMap,
    },
  }

  const winners = await fetchChannelWinners(channel, { date: today })
  assert.equal(winners.length, 2)
  assert.equal(winners[0].secret, '1000')
  assert.equal(winners[1].secret, 'SECOND')
})

test('createWinnerWorkflow handles interaction and defers reply', async () => {
  const workflow = createTestWinnerWorkflow({ defaultChannelId: DEFAULT_WINNER_CHANNEL_ID })
  const state = { replies: [], deferred: false }

  const channel = {
    id: DEFAULT_WINNER_CHANNEL_ID,
    messages: {
      fetch: async () => new Map(),
    },
  }

  const interaction = {
    isChatInputCommand: () => true,
    commandName: 'winner',
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
  assert.match(state.replies[0].content, /No guessing game winners recorded today yet/)
})

test('claim prize button handles non-winner vs winner and modal submit with dual-channel sync', async () => {
  const workflow = createTestWinnerWorkflow()

  // Non-winner button click
  const nonWinnerInteraction = {
    isButton: () => true,
    customId: 'claim_winner_prize',
    user: { id: 'imposter-999' },
    message: { id: 'winner-source-111', content: '🎉 <@winner-111>' },
    reply: async (payload) => {
      nonWinnerInteraction.replyPayload = payload
    },
  }
  const nonWinnerResult = await workflow.handleInteraction(nonWinnerInteraction)
  assert.equal(nonWinnerResult.status, 'rejected')
  assert.equal(nonWinnerResult.reason, 'not_winner')
  assert.match(nonWinnerInteraction.replyPayload.content, /Only designated winners/)

  // Winner button click
  let modalShown = null
  const winnerInteraction = {
    isButton: () => true,
    customId: 'claim_winner_prize',
    user: { id: 'winner-111' },
    message: { content: '🎉 <@winner-111>' },
    showModal: async (modal) => {
      modalShown = modal
    },
  }
  const winnerResult = await workflow.handleInteraction(winnerInteraction)
  assert.equal(winnerResult.status, 'modal_shown')
  assert.notEqual(modalShown, null)

  // Modal submit with client mock channels
  let adminSentPayload = null
  let publicSentPayload = null
  let publicEditedPayload = null

  const templatePublicMsg = {
    id: DEFAULT_PUBLIC_CLAIM_MESSAGE_ID,
    author: { id: 'bot-123' },
    content: '✧ **template message**',
    edit: async (payload) => {
      publicEditedPayload = payload
    },
  }

  const clientMock = {
    user: { id: 'bot-123' },
    channels: {
      fetch: async (channelId) => {
        if (channelId === DEFAULT_ADMIN_CLAIM_CHANNEL_ID) {
          return {
            id: DEFAULT_ADMIN_CLAIM_CHANNEL_ID,
            send: async (payload) => {
              adminSentPayload = payload
            },
          }
        }
        if (channelId === DEFAULT_PUBLIC_CLAIM_CHANNEL_ID) {
          return {
            id: DEFAULT_PUBLIC_CLAIM_CHANNEL_ID,
            messages: {
              fetch: async (msgId) => {
                if (msgId === DEFAULT_PUBLIC_CLAIM_MESSAGE_ID) return templatePublicMsg
                return null
              },
            },
            send: async (payload) => {
              publicSentPayload = payload
              return { id: 'public-notice-winner-111' }
            },
          }
        }
        return null
      },
    },
  }

  let modalReply = null
  const modalSubmitInteraction = {
    isModalSubmit: () => true,
    customId: modalShown.data.custom_id,
    user: { id: 'winner-111', username: 'WinnerUser' },
    client: clientMock,
    fields: {
      getTextInputValue: (field) => {
        if (field === 'name') return 'John Doe'
        if (field === 'gcash') return '09123456789'
        if (field === 'uid') return 'UID12345'
        return ''
      },
    },
    reply: async (payload) => {
      modalReply = payload
    },
  }

  const modalResult = await workflow.handleInteraction(modalSubmitInteraction)
  assert.equal(modalResult.status, 'success')
  assert.equal(modalResult.name, 'John Doe')
  assert.match(modalReply.content, /Prize claim submitted/)

  // Verify detailed claim sent to admin channel
  assert.notEqual(adminSentPayload, null)
  assert.match(adminSentPayload.content, /Full Name\*\*: John Doe/)
  assert.match(adminSentPayload.content, /GCash Number\*\*: 09123456789/)

  // Verify public notice posted as a fresh message in the public claims channel
  assert.notEqual(publicSentPayload, null)
  assert.match(publicSentPayload.content, /congratulations nightraid!/)
  assert.match(publicSentPayload.content, /<@winner-111>/)
  assert.match(publicSentPayload.content, /__Please wait while an admin processes your reward.__/)
  // The old template message must NOT be overwritten by a new claim
  assert.equal(publicEditedPayload, null)
})

test('a claim whose winner is mentioned in an old public message still posts a fresh congrats notice', async () => {
  const workflow = createTestWinnerWorkflow()
  let modal = null
  const sourceMessage = {
    id: 'winner-list-source',
    content: '🎉 <@winner-222> won **Word: VICTORY** (Prize: **100 GCash**)',
  }
  const buttonResult = await workflow.handleInteraction({
    id: 'winner-list-button',
    isButton: () => true,
    customId: `claim_winner_prize:${Date.now() + CLAIM_PRIZE_TTL_MS}`,
    user: { id: 'winner-222' },
    message: sourceMessage,
    showModal: async (shown) => { modal = shown },
  })
  assert.equal(buttonResult.status, 'modal_shown')

  // The public channel contains an OLD bot message that merely mentions this
  // winner (an old winners list) — it must not be edited like a notice.
  let listEdited = null
  const oldListMessage = {
    id: 'old-winner-list',
    author: { id: 'bot-123' },
    content: '🎉 <@winner-222> won **Word: OLD** — *09:00 AM*',
    edit: async (payload) => { listEdited = payload },
  }
  let sentPayload = null
  const clientMock = {
    user: { id: 'bot-123' },
    channels: {
      fetch: async (channelId) => {
        if (channelId === DEFAULT_ADMIN_CLAIM_CHANNEL_ID) {
          return { send: async () => ({ id: 'admin-notice-winner-222' }) }
        }
        if (channelId === DEFAULT_PUBLIC_CLAIM_CHANNEL_ID) {
          return {
            id: DEFAULT_PUBLIC_CLAIM_CHANNEL_ID,
            messages: {
              fetch: async (arg) => {
                if (arg && typeof arg === 'object') return new Map([[oldListMessage.id, oldListMessage]])
                return null
              },
            },
            send: async (payload) => {
              sentPayload = payload
              return { id: 'fresh-notice-winner-222' }
            },
          }
        }
        return null
      },
    },
  }

  const modalResult = await workflow.handleInteraction({
    id: 'winner-list-submit',
    isModalSubmit: () => true,
    customId: modal.data.custom_id,
    user: { id: 'winner-222' },
    client: clientMock,
    fields: { getTextInputValue: (field) => (field === 'name' ? 'List Winner' : 'N/A') },
    reply: async () => {},
  })

  assert.equal(modalResult.status, 'success')
  assert.notEqual(sentPayload, null)
  assert.match(sentPayload.content, /congratulations nightraid!/)
  assert.match(sentPayload.content, /<@winner-222>/)
  assert.equal(listEdited, null)
})

test('a winner can submit each prize claim only once', async () => {
  const now = 1_800_000_000_000
  const claimStore = new WinnerClaimStore(null)
  const workflow = createTestWinnerWorkflow({ claimStore, now: () => now })
  const expiresAt = now + CLAIM_PRIZE_TTL_MS
  let modal = null
  let sourceEdit = null
  const sourceMessage = {
    id: 'single-use-source',
    content: '<@winner-single>\nPrize: 100 GCash',
    edit: async (payload) => { sourceEdit = payload },
  }
  const buttonResult = await workflow.handleInteraction({
    id: 'single-use-button',
    isButton: () => true,
    customId: `claim_winner_prize:${expiresAt}`,
    user: { id: 'winner-single' },
    message: sourceMessage,
    showModal: async (shown) => { modal = shown },
  })
  assert.equal(buttonResult.status, 'modal_shown')

  const adminMessages = []
  const replies = []
  const channel = {
    messages: { fetch: async (messageId) => messageId === sourceMessage.id ? sourceMessage : null },
    send: async (payload) => { adminMessages.push(payload) },
  }
  const submission = (id) => ({
    id,
    isModalSubmit: () => true,
    customId: modal.data.custom_id,
    user: { id: 'winner-single' },
    fields: {
      getTextInputValue: (field) => field === 'name' ? 'Single Winner' : 'N/A',
    },
    channel,
    client: {
      channels: {
        fetch: async (channelId) => {
          if (channelId === DEFAULT_ADMIN_CLAIM_CHANNEL_ID) {
            return { send: async (payload) => { adminMessages.push(payload); return { id: 'admin-single' } } }
          }
          if (channelId === DEFAULT_PUBLIC_CLAIM_CHANNEL_ID) {
            return {
              messages: { fetch: async () => null },
              send: async () => ({ id: 'public-single' }),
            }
          }
          return null
        },
      },
    },
    reply: async (payload) => { replies.push(payload) },
  })

  const first = await workflow.handleInteraction(submission('single-use-submit-1'))
  const second = await workflow.handleInteraction(submission('single-use-submit-2'))

  assert.equal(first.status, 'success')
  assert.equal(second.status, 'rejected')
  assert.equal(second.reason, 'already_claimed')
  assert.equal(adminMessages.length, 1)
  assert.match(replies[1].content, /already claimed/i)
  assert.equal(sourceEdit.components[0].components[0].data.label, 'Prize Claimed')
  assert.equal(sourceEdit.components[0].components[0].data.disabled, true)
  assert.equal(claimStore.get(sourceMessage.id, 'winner-single').status, 'claimed')
})

test('claim status select menu updates claim status for admins and syncs public channel', async () => {
  let publicNoticeUpdated = null

  const targetPublicMsg = {
    id: DEFAULT_PUBLIC_CLAIM_MESSAGE_ID,
    author: { id: 'bot-123' },
    content: '✧ **congratulations nightraid!**\n\n🎉 <@winner-111> — ` aug 8 2026 `\n\n<:nr_status:1535222637545001082> __Please wait while an admin processes your reward.__',
    edit: async (payload) => {
      publicNoticeUpdated = payload
    },
  }

  const clientMock = {
    user: { id: 'bot-123' },
    channels: {
      fetch: async (channelId) => {
        if (channelId === DEFAULT_PUBLIC_CLAIM_CHANNEL_ID) {
          return {
            id: DEFAULT_PUBLIC_CLAIM_CHANNEL_ID,
            messages: {
              fetch: async (msgId) => {
                if (msgId && typeof msgId === 'object') return new Map([[targetPublicMsg.id, targetPublicMsg]])
                return targetPublicMsg
              },
            },
          }
        }
        return null
      },
    },
  }

  const workflow = createTestWinnerWorkflow({
    administratorIds: new Set(['admin-100']),
  })

  const cardText = renderClaimCard({
    winnerId: 'winner-111',
    name: 'Jane Doe',
    gcash: '09876543210',
    uid: 'UID777',
    status: 'pending',
    handledBy: null,
  })

  // Non-admin status change attempt
  const nonAdminInteraction = {
    isStringSelectMenu: () => true,
    customId: 'claim_status_select',
    values: ['processing'],
    user: { id: 'user-222' },
    member: { permissions: { has: () => false } },
    message: { content: cardText },
    reply: async (payload) => {
      nonAdminInteraction.replyPayload = payload
    },
  }

  const nonAdminResult = await workflow.handleInteraction(nonAdminInteraction)
  assert.equal(nonAdminResult.status, 'rejected')
  assert.equal(nonAdminResult.reason, 'unauthorized')

  // Admin status change attempt to processing
  let updatePayload = null
  const adminInteraction = {
    isStringSelectMenu: () => true,
    customId: 'claim_status_select',
    values: ['processing'],
    user: { id: 'admin-100' },
    member: { permissions: { has: () => true } },
    message: { content: cardText },
    client: clientMock,
    update: async (payload) => {
      updatePayload = payload
    },
  }

  const adminResult = await workflow.handleInteraction(adminInteraction)
  assert.equal(adminResult.status, 'updated')
  assert.equal(adminResult.newStatus, 'processing')
  assert.match(updatePayload.content, /Status\*\*: ⚙️ Processing/)
  assert.match(updatePayload.content, /Handled by\*\* — <@admin-100>/)

  // Check that public notice in message 1535223055914246185 was edited to processing
  assert.notEqual(publicNoticeUpdated, null)
  assert.match(publicNoticeUpdated.content, /__An admin is currently processing your reward.__/)

  // Admin status change attempt to done
  const adminDoneInteraction = {
    isStringSelectMenu: () => true,
    customId: 'claim_status_select',
    values: ['done'],
    user: { id: 'admin-100' },
    member: { permissions: { has: () => true } },
    message: { content: updatePayload.content },
    client: clientMock,
    update: async (payload) => {
      updatePayload = payload
    },
  }

  const adminDoneResult = await workflow.handleInteraction(adminDoneInteraction)
  assert.equal(adminDoneResult.status, 'updated')
  assert.equal(adminDoneResult.newStatus, 'done')
  assert.match(updatePayload.content, /Status\*\*: ✅ Done/)

  // Check that public notice in message 1535223055914246185 was edited to done
  assert.match(publicNoticeUpdated.content, /__Your reward has been processed and sent!__/)
})

test('duplicate claim interaction with same ID or already replied is ignored as duplicate', async () => {
  const workflow = createTestWinnerWorkflow({ administratorIds: new Set(['admin-1']) })
  const client = {
    channels: {
      fetch: async (channelId) => channelId === DEFAULT_ADMIN_CLAIM_CHANNEL_ID
        ? { send: async () => ({ id: 'admin-duplicate-test' }) }
        : {
            messages: { fetch: async () => null },
            send: async () => ({ id: 'public-duplicate-test' }),
          },
    },
  }

  const interaction1 = {
    id: 'dup-claim-1',
    isModalSubmit: () => true,
    customId: 'claim_prize_modal:user-dup-1',
    user: { id: 'user-dup-1' },
    client,
    fields: { getTextInputValue: () => 'Test Name' },
    reply: async () => {},
  }

  const result1 = await workflow.handleInteraction(interaction1)
  assert.equal(result1.status, 'success')

  // Second submission with exact same interaction ID
  const result2 = await workflow.handleInteraction(interaction1)
  assert.equal(result2.status, 'duplicate')

  // Submission with already replied flag set
  const interaction2 = {
    id: 'dup-claim-2',
    replied: true,
    isModalSubmit: () => true,
    customId: 'claim_prize_modal:user-dup-2',
    user: { id: 'user-dup-2' },
  }
  const result3 = await workflow.handleInteraction(interaction2)
  assert.equal(result3.status, 'duplicate')
})

test('separate prizes for the same winner create separate public notices keyed by source message', async () => {
  const workflow = createTestWinnerWorkflow()
  const publicMessages = new Map()
  const publicSends = []
  const adminCards = []
  const publicChannel = {
    messages: {
      fetch: async (value) => value && typeof value === 'object'
        ? new Map(publicMessages)
        : publicMessages.get(value) || null,
    },
    send: async (payload) => {
      const message = {
        id: `public-${publicSends.length + 1}`,
        author: { id: 'bot-claims' },
        content: payload.content,
        edit: async (next) => { message.content = next.content },
      }
      publicSends.push(payload)
      publicMessages.set(message.id, message)
      return message
    },
  }
  const client = {
    user: { id: 'bot-claims' },
    channels: {
      fetch: async (channelId) => channelId === DEFAULT_ADMIN_CLAIM_CHANNEL_ID
        ? { send: async (payload) => { adminCards.push(payload); return { id: `admin-${adminCards.length}` } } }
        : publicChannel,
    },
  }

  for (const [index, sourceMessageId] of ['same-winner-prize-a', 'same-winner-prize-b'].entries()) {
    let modal
    const button = await workflow.handleInteraction({
      id: `same-winner-button-${index}`,
      isButton: () => true,
      customId: `claim_winner_prize:${Date.now() + CLAIM_PRIZE_TTL_MS}`,
      user: { id: 'same-winner' },
      message: {
        id: sourceMessageId,
        content: `<@same-winner>\nPrize: **${index === 0 ? 50 : 200} GCash**`,
      },
      showModal: async (value) => { modal = value },
    })
    assert.equal(button.status, 'modal_shown')

    const submission = await workflow.handleInteraction({
      id: `same-winner-submit-${index}`,
      isModalSubmit: () => true,
      customId: modal.data.custom_id,
      user: { id: 'same-winner' },
      client,
      fields: { getTextInputValue: (field) => field === 'name' ? 'Repeat Winner' : 'N/A' },
      reply: async () => {},
    })
    assert.equal(submission.status, 'success')
  }

  assert.equal(publicSends.length, 2)
  assert.equal(adminCards.length, 2)
  assert.match(publicSends[0].content, /Claim reference: same-winner-prize-a/)
  assert.match(publicSends[1].content, /Claim reference: same-winner-prize-b/)
  assert.match(publicSends[0].content, /` P50 `/)
  assert.match(publicSends[1].content, /` P200 `/)

  const firstNoticeBeforeStatus = publicMessages.get('public-1').content
  const statusCustomId = adminCards[1].components[0].components[0].data.custom_id
  let updatedAdminCard
  const statusResult = await workflow.handleInteraction({
    id: 'same-winner-status-second-claim',
    isStringSelectMenu: () => true,
    customId: statusCustomId,
    values: ['done'],
    user: { id: 'admin-status' },
    member: { permissions: { has: () => true } },
    message: { content: adminCards[1].content },
    client,
    update: async (payload) => { updatedAdminCard = payload },
  })
  assert.equal(statusResult.status, 'updated')
  assert.equal(publicMessages.get('public-1').content, firstNoticeBeforeStatus)
  assert.match(publicMessages.get('public-2').content, /processed and sent/i)
  assert.match(updatedAdminCard.content, /Claim reference: same-winner-prize-b/)
})

test('a public channel send failure is reported as partial success without losing the stored claim', async () => {
  const claimStore = new WinnerClaimStore(null)
  const workflow = createTestWinnerWorkflow({ claimStore })
  let modal
  await workflow.handleInteraction({
    id: 'delivery-failure-button',
    isButton: () => true,
    customId: `claim_winner_prize:${Date.now() + CLAIM_PRIZE_TTL_MS}`,
    user: { id: 'delivery-winner' },
    message: { id: 'delivery-source', content: '<@delivery-winner>\nPrize: **100 GCash**' },
    showModal: async (value) => { modal = value },
  })

  let replyPayload
  const missingPermission = Object.assign(new Error('Missing Permissions'), { code: 50013, status: 403 })
  const result = await workflow.handleInteraction({
    id: 'delivery-failure-submit',
    isModalSubmit: () => true,
    customId: modal.data.custom_id,
    user: { id: 'delivery-winner' },
    client: {
      channels: {
        fetch: async (channelId) => channelId === DEFAULT_ADMIN_CLAIM_CHANNEL_ID
          ? { send: async () => ({ id: 'admin-delivered' }) }
          : { messages: { fetch: async () => null }, send: async () => { throw missingPermission } },
      },
    },
    fields: { getTextInputValue: (field) => field === 'name' ? 'Delivery Winner' : 'N/A' },
    reply: async (payload) => { replyPayload = payload },
  })

  assert.equal(result.status, 'partial_success')
  assert.equal(result.publicDelivery.reason, 'public_notice_send_failed')
  assert.equal(result.publicDelivery.error.code, 50013)
  assert.match(replyPayload.content, /securely recorded/i)
  assert.match(replyPayload.content, /delivery-source/)
  assert.equal(claimStore.get('delivery-source', 'delivery-winner').status, 'claimed')
})

test('an unavailable admin channel never leaks private claim details into the interaction channel', async () => {
  const workflow = createTestWinnerWorkflow()
  let modal
  await workflow.handleInteraction({
    id: 'private-fallback-button',
    isButton: () => true,
    customId: `claim_winner_prize:${Date.now() + CLAIM_PRIZE_TTL_MS}`,
    user: { id: 'private-winner' },
    message: { id: 'private-source', content: '<@private-winner>\nPrize: **100 GCash**' },
    showModal: async (value) => { modal = value },
  })

  let interactionChannelSends = 0
  const result = await workflow.handleInteraction({
    id: 'private-fallback-submit',
    isModalSubmit: () => true,
    customId: modal.data.custom_id,
    user: { id: 'private-winner' },
    client: {
      channels: {
        fetch: async (channelId) => {
          if (channelId === DEFAULT_ADMIN_CLAIM_CHANNEL_ID) throw new Error('Missing Access')
          return {
            messages: { fetch: async () => null },
            send: async () => ({ id: 'public-private-winner' }),
          }
        },
      },
    },
    channel: { send: async () => { interactionChannelSends += 1 } },
    fields: {
      getTextInputValue: (field) => field === 'name'
        ? 'Private Winner'
        : field === 'gcash' ? '09123456789' : 'SECRET-UID',
    },
    reply: async () => {},
  })

  assert.equal(result.status, 'partial_success')
  assert.equal(result.adminDelivery.reason, 'admin_claim_send_failed')
  assert.equal(interactionChannelSends, 0)
})

test('winner claim storage fails closed on corrupt data and unwritable destinations', () => {
  const corruptPath = path.join(os.tmpdir(), `winner-claims-corrupt-${Date.now()}.json`)
  fs.writeFileSync(corruptPath, '{not valid json', 'utf8')
  const corruptStore = new WinnerClaimStore(corruptPath)
  assert.throws(
    () => corruptStore.get('source', 'winner'),
    (error) => error?.code === 'WINNER_CLAIM_STORE_FAILED',
  )
  fs.unlinkSync(corruptPath)

  const invalidParent = path.join(os.tmpdir(), `winner-claims-parent-${Date.now()}`)
  fs.writeFileSync(invalidParent, 'this is a file, not a directory', 'utf8')
  const unwritableStore = new WinnerClaimStore(path.join(invalidParent, 'claims.json'))
  assert.throws(
    () => unwritableStore.claim({
      sourceMessageId: 'source',
      winnerId: 'winner',
      expiresAt: Date.now() + CLAIM_PRIZE_TTL_MS,
    }),
    (error) => error?.code === 'WINNER_CLAIM_STORE_FAILED',
  )
  fs.unlinkSync(invalidParent)
})
