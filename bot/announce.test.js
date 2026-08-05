import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ANNOUNCE_COMMAND,
  announcementBody,
  announcementMentions,
  buildAnnouncementContent,
  canAnnounce,
  createAnnounceWorkflow,
} from './announce.js'

const CHANNEL_ID = '1208605026868535387'

function announceInteraction({
  userId = 'admin-1',
  roles = [],
  administrator = false,
  channel = { id: CHANNEL_ID },
  message = 'Scrims start at 8 PM.',
  mention = null,
  target = null,
  sendResult = { id: 'msg-1', url: 'https://discord.com/channels/guild-1/1/msg-1' },
} = {}) {
  const state = { sent: [], replies: [], deferred: false }
  const destination = target ?? {
    id: CHANNEL_ID,
    guildId: 'guild-1',
    isTextBased: () => true,
    send: async (payload) => {
      state.sent.push(payload)
      return sendResult
    },
  }
  return {
    state,
    isChatInputCommand: () => true,
    commandName: ANNOUNCE_COMMAND.name,
    guildId: 'guild-1',
    user: { id: userId },
    member: {
      permissions: { has: () => administrator },
      roles: { cache: new Map(roles.map((role) => [role.id, role])) },
    },
    options: {
      getChannel: () => channel,
      getString: (name) => (name === 'message' ? message : mention),
    },
    client: { channels: { fetch: async () => destination } },
    deferReply: async () => {
      state.deferred = true
    },
    reply: async (payload) => {
      state.replies.push(payload)
    },
    editReply: async (payload) => {
      state.replies.push(payload)
    },
  }
}

test('the command takes a channel, a message, and an optional mention', () => {
  assert.equal(ANNOUNCE_COMMAND.name, 'announce')
  assert.deepEqual(
    ANNOUNCE_COMMAND.options.map((option) => [option.name, option.required === true]),
    [['channel', true], ['message', true], ['mention', false]],
  )
  assert.deepEqual(
    ANNOUNCE_COMMAND.options[2].choices.map((choice) => choice.value),
    ['none', 'here', 'everyone'],
  )
})

test('a typed \\n becomes a real line break', () => {
  assert.equal(
    announcementBody('Round 1 at 8 PM.\\n\\nBring your slot code.'),
    'Round 1 at 8 PM.\n\nBring your slot code.',
  )
  assert.equal(announcementBody('Pasted\nline break.'), 'Pasted\nline break.')
})

test('the mention is added above the message', () => {
  assert.equal(
    buildAnnouncementContent({ message: 'Scrims at 8 PM.', mention: 'everyone' }),
    '@everyone\n\nScrims at 8 PM.',
  )
  assert.equal(
    buildAnnouncementContent({ message: 'Scrims at 8 PM.' }),
    'Scrims at 8 PM.',
  )
})

test('an empty or oversized announcement is refused', () => {
  assert.throws(() => buildAnnouncementContent({ message: '   ' }), /empty/i)
  assert.throws(
    () => buildAnnouncementContent({ message: 'x'.repeat(2_001) }),
    /2001 characters/,
  )
})

test('@everyone is only parsed when the mention option asked for it', () => {
  assert.deepEqual(announcementMentions('none'), { parse: ['users', 'roles'] })
  assert.deepEqual(announcementMentions('here'), { parse: ['users', 'roles', 'everyone'] })
  assert.deepEqual(announcementMentions('everyone'), { parse: ['users', 'roles', 'everyone'] })
})

test('only administrators and the configured roles may announce', () => {
  const base = { administratorIds: new Set(['admin-1']) }
  assert.equal(
    canAnnounce({ interaction: { user: { id: 'admin-1' } }, member: null, ...base }),
    true,
  )
  assert.equal(
    canAnnounce({
      interaction: { user: { id: 'member-9' } },
      member: { roles: [{ id: 'role-1', name: 'Announcer' }] },
      ...base,
    }),
    true,
  )
  assert.equal(
    canAnnounce({
      interaction: { user: { id: 'member-9' } },
      member: { roles: [{ id: 'role-2', name: 'Member' }] },
      ...base,
    }),
    false,
  )
})

test('an unauthorized member posts nothing', async () => {
  const workflow = createAnnounceWorkflow({ administratorIds: new Set(['admin-1']) })
  const interaction = announceInteraction({ userId: 'member-9' })
  const result = await workflow.handleInteraction(interaction)
  assert.equal(result.status, 'unauthorized')
  assert.deepEqual(interaction.state.sent, [])
  assert.match(interaction.state.replies[0].content, /administrator/i)
})

test('the message is posted into the chosen channel', async () => {
  const workflow = createAnnounceWorkflow({ administratorIds: new Set(['admin-1']) })
  const interaction = announceInteraction({
    message: 'Round 1 at 8 PM.\\nBring your slot code.',
    mention: 'here',
  })
  const result = await workflow.handleInteraction(interaction)
  assert.equal(result.status, 'posted')
  assert.deepEqual(interaction.state.sent, [{
    content: '@here\n\nRound 1 at 8 PM.\nBring your slot code.',
    allowedMentions: { parse: ['users', 'roles', 'everyone'] },
  }])
  assert.match(interaction.state.replies[0].content, /Announcement posted in <#1208605026868535387>/)
})

test('an oversized message is reported without posting anything', async () => {
  const workflow = createAnnounceWorkflow({ administratorIds: new Set(['admin-1']) })
  const interaction = announceInteraction({ message: 'x'.repeat(2_001) })
  const result = await workflow.handleInteraction(interaction)
  assert.equal(result.status, 'rejected')
  assert.deepEqual(interaction.state.sent, [])
  assert.equal(interaction.state.deferred, false)
})

test('a channel outside this server is refused', async () => {
  const workflow = createAnnounceWorkflow({ administratorIds: new Set(['admin-1']) })
  const interaction = announceInteraction({
    target: {
      id: CHANNEL_ID,
      guildId: 'other-guild',
      isTextBased: () => true,
      send: async () => assert.fail('The announcement must not leave the server.'),
    },
  })
  await assert.rejects(workflow.handleInteraction(interaction), /not part of this server/)
})

test('other commands are ignored', async () => {
  const workflow = createAnnounceWorkflow({ administratorIds: new Set(['admin-1']) })
  const result = await workflow.handleInteraction({
    isChatInputCommand: () => true,
    commandName: 'standings',
  })
  assert.equal(result.status, 'ignored')
})
