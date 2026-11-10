import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { Events } from 'discord.js'

import {
  createInitialScrimSlots,
  createWaitlistContent,
  monitorScrimInitialization,
  installScrimAutomation,
} from './scrim-automation.js'

test('logs initialization failure without converting it into an unhandled rejection', async () => {
  const failure = new Error('Missing Access')
  const initialization = Promise.reject(failure)
  const reported = []

  const monitored = monitorScrimInitialization(initialization, (reason) => reported.push(reason))

  assert.equal(monitored, initialization)
  await assert.rejects(monitored, failure)
  await Promise.resolve()
  assert.deepEqual(reported, [failure])
})

test('starts every new scrim with all 25 slots available for registration', () => {
  assert.deepEqual(createInitialScrimSlots(), Array(25).fill(null))
})

test('does not render a wait-list message while nobody is waiting', () => {
  assert.equal(createWaitlistContent([]), null)
})

test('renders the wait list after a team overflows the registered slots', () => {
  const content = createWaitlistContent([
    {
      tag: 'NR',
      name: 'NIGHTRAID SHADOW',
    },
  ])

  assert.match(content, /^# WAIT LIST/m)
  assert.match(content, /W01\s+: NR\s+- NIGHTRAID SHADOW/)
})


test('releases only automatic reservations across restart and accepts both teams as normal signups', async (t) => {
  const cutover = Date.parse('2026-11-10T16:43:00Z')
  t.mock.method(Date, 'now', () => cutover + 60_000)
  const registrationId = '1260139820836065300'
  const cancellationId = '1344620122094174281'
  const boardId = '1260501981508669471'
  const lists = new Map([registrationId, cancellationId, boardId].map(id => [id, new Map()]))
  const client = new EventEmitter()
  client.user = { id: 'bot' }
  client.channels = { fetch: async id => ({
    isTextBased: () => true,
    messages: {
      fetch: async query => typeof query === 'string' ? lists.get(id).get(query) : lists.get(id),
      fetchPins: async () => ({ items: [] }),
    },
    send: async payload => {
      const message = { ...payload, id: String(lists.get(id).size + 1), author: client.user,
        embeds: [], edit: async update => Object.assign(message, update) }
      lists.get(id).set(message.id, message)
      return message
    },
  }) }
  function post(channelId, content, offset, replyTo) {
    const id = String(cutover + offset)
    lists.get(channelId).set(id, { id, channelId, content, createdTimestamp: cutover + offset,
      author: { id: '294888876940460033' }, attachments: new Map(), embeds: [],
      reference: replyTo ? { messageId: replyTo } : undefined })
    return id
  }
  post(registrationId, 'https://example.test/open.gif', -9000)
  post(registrationId, '🇵🇭 | OTHER - EXISTING TEAM', -8000)
  post(registrationId, '🇵🇭 | NR - NIGHTRAID ESPORTS', -7000)
  const { registeredTeamSource } = installScrimAutomation(client)
  client.emit(Events.ClientReady, client)
  const slots = snapshot => snapshot.teams.map(row => [row.slot_number, row.team_tag])
  assert.deepEqual(slots(await registeredTeamSource.readSnapshot()), [[3, 'OTHER']])

  const cancelId = post(cancellationId, 'CANCEL - APEX SYNDICATE', -6000)
  post(cancellationId, 'MINE - APXS - APEX SYNDICATE', -5000, cancelId)
  post(registrationId, '🇵🇭 | NR - NIGHTRAID ESPORTS', 1000)
  post(registrationId, '🇵🇭 | NR - NIGHTRAID ESPORTS', 2000)
  const snapshot = await registeredTeamSource.refreshSnapshot()
  assert.deepEqual(slots(snapshot), [[1, 'NR'], [2, 'APXS'], [3, 'OTHER']])
  assert.ok(snapshot.teams.every(team => team.source_message_id))
  assert.deepEqual(slots(await registeredTeamSource.refreshSnapshot()), slots(snapshot))

  post(registrationId, 'https://example.test/new.gif', 5000)
  post(registrationId, '🇵🇭 | FIRST - FIRST SIGNUP', 6000)
  post(registrationId, '🇵🇭 | APXS - APEX SYNDICATE', 7000)
  post(registrationId, '🇵🇭 | NR - NIGHTRAID ESPORTS', 8000)
  assert.deepEqual(slots(await registeredTeamSource.refreshSnapshot()), [[1, 'FIRST'], [2, 'APXS'], [3, 'NR']])
})
