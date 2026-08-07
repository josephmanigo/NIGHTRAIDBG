import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_WINNER_CHANNEL_ID,
  WINNER_COMMAND,
  createClaimPrizeButton,
  createClaimStatusSelectMenu,
  createWinnerWorkflow,
  fetchChannelWinners,
  isSameDay,
  parseWinnerFromMessage,
  renderClaimCard,
  renderWinnersList,
} from './winner.js'

test('WINNER_COMMAND has the correct command structure', () => {
  assert.equal(WINNER_COMMAND.name, 'winner')
  assert.equal(DEFAULT_WINNER_CHANNEL_ID, '1534862469367992321')
  assert.equal(WINNER_COMMAND.options.length, 1)
  assert.equal(WINNER_COMMAND.options[0].name, 'channel')
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
  const workflow = createWinnerWorkflow({ defaultChannelId: DEFAULT_WINNER_CHANNEL_ID })
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

test('claim prize button handles non-winner vs winner and modal submit', async () => {
  const workflow = createWinnerWorkflow()

  // Non-winner button click
  const nonWinnerInteraction = {
    isButton: () => true,
    customId: 'claim_winner_prize',
    user: { id: 'imposter-999' },
    message: { content: '🎉 <@winner-111>' },
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

  // Modal submit
  let modalReply = null
  const modalSubmitInteraction = {
    isModalSubmit: () => true,
    customId: 'claim_prize_modal:winner-111',
    user: { id: 'winner-111', username: 'WinnerUser' },
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
})

test('claim status select menu updates claim status for admins and rejects non-admins', async () => {
  const workflow = createWinnerWorkflow({
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
    update: async (payload) => {
      updatePayload = payload
    },
  }

  const adminResult = await workflow.handleInteraction(adminInteraction)
  assert.equal(adminResult.status, 'updated')
  assert.equal(adminResult.newStatus, 'processing')
  assert.match(updatePayload.content, /Status\*\*: ⚙️ Processing/)
  assert.match(updatePayload.content, /Handled by\*\* — <@admin-100>/)

  // Admin status change attempt to done
  const adminDoneInteraction = {
    isStringSelectMenu: () => true,
    customId: 'claim_status_select',
    values: ['done'],
    user: { id: 'admin-100' },
    member: { permissions: { has: () => true } },
    message: { content: updatePayload.content },
    update: async (payload) => {
      updatePayload = payload
    },
  }

  const adminDoneResult = await workflow.handleInteraction(adminDoneInteraction)
  assert.equal(adminDoneResult.status, 'updated')
  assert.equal(adminDoneResult.newStatus, 'done')
  assert.match(updatePayload.content, /Status\*\*: ✅ Done/)
})
