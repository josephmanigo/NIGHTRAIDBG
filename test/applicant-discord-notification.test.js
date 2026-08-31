import assert from 'node:assert/strict'
import test from 'node:test'
import { notifyApplicantThroughDiscord } from '../server/applicant-discord-notification.ts'

function harness(overrides = {}) {
  const calls = []
  const dependencies = {
    fetchMember: async () => ({ id: 'member' }),
    validAccessToken: async () => {
      calls.push('token')
      return 'access-token'
    },
    addMember: async () => {
      calls.push('add')
      return true
    },
    sendDirectMessage: async () => {
      calls.push('dm')
    },
    removeMember: async () => {
      calls.push('remove')
    },
    reportError: () => undefined,
    ...overrides,
  }
  return { calls, dependencies }
}

test('an existing Discord member receives the application decision DM', async () => {
  const { calls, dependencies } = harness()
  const result = await notifyApplicantThroughDiscord('user-1', 'decision', {}, dependencies)

  assert.deepEqual(result, { applicantNotification: 'COMPLETED' })
  assert.deepEqual(calls, ['dm'])
})

test('acceptance can fall back to the status portal when the applicant is not in Discord', async () => {
  const { calls, dependencies } = harness({ fetchMember: async () => null })
  const result = await notifyApplicantThroughDiscord('user-1', 'accepted', {}, dependencies)

  assert.deepEqual(result, { applicantNotification: 'PORTAL_ONLY' })
  assert.deepEqual(calls, [])
})

test('rejection temporarily joins an absent applicant, sends the DM, then removes them', async () => {
  const { calls, dependencies } = harness({ fetchMember: async () => null })
  const result = await notifyApplicantThroughDiscord(
    'user-1',
    'rejected',
    { temporarilyJoinForDelivery: true },
    dependencies,
  )

  assert.deepEqual(result, { applicantNotification: 'COMPLETED' })
  assert.deepEqual(calls, ['token', 'add', 'dm', 'remove'])
})

test('a rejected applicant is still removed when their Discord DMs are closed', async () => {
  const { calls, dependencies } = harness({
    fetchMember: async () => null,
    sendDirectMessage: async () => {
      calls.push('dm')
      throw new Error('Cannot send messages to this user')
    },
  })
  const result = await notifyApplicantThroughDiscord(
    'user-1',
    'rejected',
    { temporarilyJoinForDelivery: true },
    dependencies,
  )

  assert.equal(result.applicantNotification, 'FAILED')
  assert.match(result.notificationError, /Cannot send messages/)
  assert.deepEqual(calls, ['token', 'add', 'dm', 'remove'])
})

test('an invalid bot credential fails closed before reporting a decision DM as sent', async () => {
  const { calls, dependencies } = harness({
    fetchMember: async () => {
      throw new Error('Discord API request failed with status 401')
    },
  })
  const result = await notifyApplicantThroughDiscord('user-1', 'decision', {}, dependencies)

  assert.equal(result.applicantNotification, 'FAILED')
  assert.match(result.notificationError, /status 401/)
  assert.deepEqual(calls, [])
})
