import assert from 'node:assert/strict'
import test from 'node:test'
import { addDiscordGuildMemberWithTokenRecovery } from '../server/discord-token-recovery.ts'

function invalidOAuthTokenError() {
  return Object.assign(
    new Error('Adding the applicant to the NIGHTRAID server failed with Discord status 403. Invalid OAuth2 access token (50025).'),
    { discordCode: 50025, discordStatus: 403 },
  )
}

test('Discord 50025 forces one token refresh and retries the guild join', async () => {
  const calls = []
  const result = await addDiscordGuildMemberWithTokenRecovery('user-1', ['role-1'], {
    accessToken: async (_userId, forceRefresh) => {
      calls.push(`token:${forceRefresh}`)
      return forceRefresh ? 'fresh-token' : 'stale-token'
    },
    addMember: async (_userId, token, roleIds) => {
      calls.push(`add:${token}:${roleIds.join(',')}`)
      if (token === 'stale-token') throw invalidOAuthTokenError()
      return true
    },
  })

  assert.equal(result, true)
  assert.deepEqual(calls, [
    'token:false',
    'add:stale-token:role-1',
    'token:true',
    'add:fresh-token:role-1',
  ])
})

test('a second Discord 50025 asks the applicant to reconnect instead of retrying forever', async () => {
  let attempts = 0
  await assert.rejects(
    () => addDiscordGuildMemberWithTokenRecovery('user-1', [], {
      accessToken: async (_userId, forceRefresh) => forceRefresh ? 'fresh-token' : 'stale-token',
      addMember: async () => {
        attempts += 1
        throw invalidOAuthTokenError()
      },
    }),
    /reconnect Discord/i,
  )
  assert.equal(attempts, 2)
})

test('non-token Discord errors are not retried', async () => {
  const calls = []
  await assert.rejects(
    () => addDiscordGuildMemberWithTokenRecovery('user-1', [], {
      accessToken: async (_userId, forceRefresh) => {
        calls.push(`token:${forceRefresh}`)
        return 'access-token'
      },
      addMember: async () => {
        calls.push('add')
        throw Object.assign(new Error('Missing Permissions'), { discordCode: 50013, discordStatus: 403 })
      },
    }),
    /Missing Permissions/,
  )
  assert.deepEqual(calls, ['token:false', 'add'])
})

test('an unauthorized stored bearer token is refreshed before the guild join', async () => {
  const calls = []
  const result = await addDiscordGuildMemberWithTokenRecovery('user-1', [], {
    accessToken: async (_userId, forceRefresh) => {
      calls.push(`token:${forceRefresh}`)
      return forceRefresh ? 'fresh-token' : 'stale-token'
    },
    validateAccessToken: async (token) => {
      calls.push(`validate:${token}`)
      if (token === 'stale-token') {
        throw Object.assign(new Error('Discord API request failed with status 401.'), { discordStatus: 401 })
      }
    },
    addMember: async (_userId, token) => {
      calls.push(`add:${token}`)
      return true
    },
  })

  assert.equal(result, true)
  assert.deepEqual(calls, [
    'token:false',
    'validate:stale-token',
    'token:true',
    'validate:fresh-token',
    'add:fresh-token',
  ])
})

test('an identity mismatch fails without wasting a token refresh', async () => {
  const calls = []
  await assert.rejects(
    () => addDiscordGuildMemberWithTokenRecovery('user-1', [], {
      accessToken: async (_userId, forceRefresh) => {
        calls.push(`token:${forceRefresh}`)
        return 'access-token'
      },
      validateAccessToken: async () => {
        calls.push('validate')
        throw new Error('DISCORD_BOT_TOKEN and DISCORD_CLIENT_ID belong to different Discord applications.')
      },
      addMember: async () => {
        calls.push('add')
        return true
      },
    }),
    /different Discord applications/,
  )
  assert.deepEqual(calls, ['token:false', 'validate'])
})
