import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ANNOUNCE_COMMAND,
  announcementBody,
  announcementMentions,
  assertAnnouncementPhoto,
  buildAnnouncementContent,
  canAnnounce,
  createAnnounceWorkflow,
  downloadAnnouncementPhoto,
} from './announce.js'

const CHANNEL_ID = '1208605026868535387'

function announceInteraction({
  id = null,
  userId = 'admin-1',
  roles = [],
  administrator = false,
  channel = { id: CHANNEL_ID },
  message = 'Scrims start at 8 PM.',
  prize = null,
  mention = null,
  photo = null,
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
    id,
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
      getString: (name) => {
        if (name === 'message') return message
        if (name === 'prize' || name === 'price') return prize
        if (name === 'mention') return mention
        return null
      },
      getAttachment: () => photo,
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

test('the command takes a channel, a message, an optional prize, an optional photo, an optional mention, and an optional claim button', () => {
  assert.equal(ANNOUNCE_COMMAND.name, 'announce')
  assert.deepEqual(
    ANNOUNCE_COMMAND.options.map((option) => [option.name, option.required === true]),
    [['channel', true], ['message', true], ['prize', false], ['photo', false], ['mention', false], ['claim_button', false]],
  )
  assert.deepEqual(
    ANNOUNCE_COMMAND.options[4].choices.map((choice) => choice.value),
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

test('the mention is added above the message and optional prize below', () => {
  assert.equal(
    buildAnnouncementContent({ message: 'Scrims at 8 PM.', mention: 'everyone' }),
    '@everyone\n\nScrims at 8 PM.',
  )
  assert.equal(
    buildAnnouncementContent({ message: 'Scrims at 8 PM.' }),
    'Scrims at 8 PM.',
  )
  assert.equal(
    buildAnnouncementContent({ message: 'Scrims at 8 PM.', prize: '₱100 GCash', mention: 'everyone' }),
    '@everyone\n\nScrims at 8 PM.\n\n💸 **Prize**: ₱100 GCash',
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

test('only photos are accepted as the attachment', () => {
  assert.equal(
    assertAnnouncementPhoto({ contentType: 'image/png', name: 'poster.png', size: 1_000 }).name,
    'poster.png',
  )
  /* Some clients send no content type, so the extension decides. */
  assert.doesNotThrow(() => assertAnnouncementPhoto({ name: 'bracket.JPG', size: 1_000 }))
  assert.throws(
    () => assertAnnouncementPhoto({ contentType: 'application/pdf', name: 'rules.pdf', size: 10 }),
    /must be a photo/,
  )
  assert.throws(
    () => assertAnnouncementPhoto({ contentType: 'image/png', name: 'huge.png', size: 11 * 1_024 * 1_024 }),
    /larger than 10 MiB/,
  )
})

test('the photo is re-uploaded from its bytes, not linked', async () => {
  const file = await downloadAnnouncementPhoto(
    { url: 'https://cdn.discordapp.com/a.png', name: 'poster.png' },
    async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }),
  )
  assert.equal(file.name, 'poster.png')
  assert.deepEqual([...file.attachment], [1, 2, 3])
  await assert.rejects(
    downloadAnnouncementPhoto(
      { url: 'https://cdn.discordapp.com/a.png', name: 'poster.png' },
      async () => ({ ok: false, status: 404 }),
    ),
    /status 404/,
  )
})

test('an attached photo is posted with the announcement', async () => {
  const workflow = createAnnounceWorkflow({
    administratorIds: new Set(['admin-1']),
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([7, 7]).buffer }),
  })
  const interaction = announceInteraction({
    message: 'Bracket is out.',
    photo: {
      url: 'https://cdn.discordapp.com/bracket.png',
      name: 'bracket.png',
      contentType: 'image/png',
      size: 2,
    },
  })
  const result = await workflow.handleInteraction(interaction)
  assert.equal(result.status, 'posted')
  assert.equal(result.photo, true)
  const [payload] = interaction.state.sent
  assert.equal(payload.content, 'Bracket is out.')
  assert.equal(payload.files.length, 1)
  assert.equal(payload.files[0].name, 'bracket.png')
  assert.deepEqual([...payload.files[0].attachment], [7, 7])
})

test('a message without a photo carries no files field', async () => {
  const workflow = createAnnounceWorkflow({ administratorIds: new Set(['admin-1']) })
  const interaction = announceInteraction({ message: 'Text only.' })
  await workflow.handleInteraction(interaction)
  assert.equal('files' in interaction.state.sent[0], false)
})

test('a non-photo attachment is refused before anything is posted', async () => {
  const workflow = createAnnounceWorkflow({
    administratorIds: new Set(['admin-1']),
    fetchImpl: async () => assert.fail('A rejected attachment must never be downloaded.'),
  })
  const interaction = announceInteraction({
    photo: { url: 'https://cdn.discordapp.com/rules.pdf', name: 'rules.pdf', contentType: 'application/pdf', size: 10 },
  })
  const result = await workflow.handleInteraction(interaction)
  assert.equal(result.status, 'rejected')
  assert.deepEqual(interaction.state.sent, [])
  assert.equal(interaction.state.deferred, false)
  assert.match(interaction.state.replies[0].content, /must be a photo/)
})

test('other commands are ignored', async () => {
  const workflow = createAnnounceWorkflow({ administratorIds: new Set(['admin-1']) })
  const result = await workflow.handleInteraction({
    isChatInputCommand: () => true,
    commandName: 'standings',
  })
  assert.equal(result.status, 'ignored')
})

test('avoids duplicate channel fetch when channel option is already text-based', async () => {
  let fetchCalled = false
  const workflow = createAnnounceWorkflow({ administratorIds: new Set(['admin-1']) })
  const destination = {
    id: CHANNEL_ID,
    guildId: 'guild-1',
    isTextBased: () => true,
    send: async () => ({ id: 'msg-1' }),
  }
  const interaction = announceInteraction({
    channel: destination,
    target: destination,
  })
  interaction.client.channels.fetch = async () => {
    fetchCalled = true
    return destination
  }
  const result = await workflow.handleInteraction(interaction)
  assert.equal(result.status, 'posted')
  assert.equal(fetchCalled, false)
})

test('duplicate interaction with same ID is ignored and posted only once', async () => {
  const workflow = createAnnounceWorkflow({ administratorIds: new Set(['admin-1']) })
  const interaction = announceInteraction({
    id: 'duplicate-int-100',
    message: 'Test message',
  })
  const firstResult = await workflow.handleInteraction(interaction)
  assert.equal(firstResult.status, 'posted')
  assert.equal(interaction.state.sent.length, 1)

  const secondResult = await workflow.handleInteraction(interaction)
  assert.equal(secondResult.status, 'duplicate')
  assert.equal(interaction.state.sent.length, 1)
})

test('Discord nonce prevents duplicate posts across separate bot workflows', async () => {
  const deliveries = []
  const target = {
    id: CHANNEL_ID,
    guildId: 'guild-1',
    isTextBased: () => true,
    send: async (payload) => {
      const existing = deliveries.find((delivery) =>
        payload.enforceNonce && delivery.payload.nonce === payload.nonce)
      if (existing) return existing.message
      const message = { id: `msg-${deliveries.length + 1}` }
      deliveries.push({ payload, message })
      return message
    },
  }
  const workflowOptions = () => ({
    administratorIds: new Set(['admin-1']),
    handledInteractions: new Set(),
    inFlightInteractions: new Set(),
  })
  const first = announceInteraction({ id: 'cross-process-int-100', target })
  const second = announceInteraction({ id: 'cross-process-int-100', target })

  const results = await Promise.all([
    createAnnounceWorkflow(workflowOptions()).handleInteraction(first),
    createAnnounceWorkflow(workflowOptions()).handleInteraction(second),
  ])

  assert.deepEqual(results.map((result) => result.status), ['posted', 'posted'])
  assert.equal(deliveries.length, 1)
  assert.equal(deliveries[0].payload.nonce, 'cross-process-int-100')
  assert.equal(deliveries[0].payload.enforceNonce, true)
})

test('already replied or deferred interaction is ignored as duplicate', async () => {
  const workflow = createAnnounceWorkflow({ administratorIds: new Set(['admin-1']) })
  const interaction = announceInteraction({
    id: 'already-replied-int',
    message: 'Test message',
  })
  interaction.deferred = true
  const result = await workflow.handleInteraction(interaction)
  assert.equal(result.status, 'duplicate')
  assert.equal(interaction.state.sent.length, 0)
})


