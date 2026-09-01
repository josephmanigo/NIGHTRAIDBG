import assert from 'node:assert/strict'
import test from 'node:test'
import {
  NIGHTBUDDY_APPLICATION_ID,
  NIGHTBUDDY_READY_BODY,
  NIGHTRAID_ADMIN_DISCORD_IDS,
  NIGHTRAID_APP_ORIGIN,
  NIGHTRAID_DISCORD_CALLBACK,
  NIGHTRAID_GAME_ROLE_ENV_NAMES,
  NIGHTRAID_GUILD_ID,
  NIGHTRAID_REVIEW_CHANNEL_ID,
} from '../bot/production-contract.js'
import {
  validateProductionLiveEndpoints,
  validateProductionReadiness,
  validateProductionStability,
} from '../scripts/production-live-readiness.mjs'
import { REQUIRED_WEB_ENV } from '../scripts/vercel-web-env-preflight.mjs'

function passingFetch(input) {
  const url = new URL(String(input))
  if (url.pathname === '/health') return new Response(NIGHTBUDDY_READY_BODY, { status: 200 })
  if (url.pathname === '/api/auth/discord') {
    const returnTo = url.searchParams.get('returnTo')
    const state = returnTo === '/admin/applications' ? 'admin-state' : 'applicant-state'
    const authorize = new URL('https://discord.com/oauth2/authorize')
    authorize.searchParams.set('client_id', NIGHTBUDDY_APPLICATION_ID)
    authorize.searchParams.set('redirect_uri', NIGHTRAID_DISCORD_CALLBACK)
    authorize.searchParams.set('scope', 'identify guilds.join')
    authorize.searchParams.set('state', state)
    const headers = new Headers({ location: authorize.toString() })
    headers.append('set-cookie', `nr_oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax`)
    headers.append('set-cookie', `nr_return_to=${returnTo}; Path=/; HttpOnly; Secure; SameSite=Lax`)
    return new Response(null, { status: 302, headers })
  }
  return new Response('Not found', { status: 404 })
}

test('the live probe validates Render readiness and the canonical NIGHTBUDDY OAuth redirect', async () => {
  assert.deepEqual(await validateProductionLiveEndpoints({ fetchImpl: passingFetch }), [])
})

test('the live probe reports false-green health and OAuth responses', async () => {
  const fetchImpl = async (input) => {
    const url = new URL(String(input))
    if (url.pathname === '/health') return new Response('Nickname bot is running.', { status: 200 })
    return new Response(null, {
      status: 302,
      headers: { location: 'https://discord.com/oauth2/authorize?client_id=wrong' },
    })
  }
  const problems = (await validateProductionLiveEndpoints({ fetchImpl })).join('\n')
  assert.match(problems, /instead of a ready response/)
  assert.match(problems, /NIGHTBUDDY application/)
  assert.match(problems, /canonical NIGHTRAID callback/)
  assert.match(problems, /identify and guilds.join/)
})

test('the stability gate repeats the full live probe', async () => {
  let requests = 0
  await validateProductionStability({
    attempts: 3,
    intervalMs: 0,
    fetchImpl: async (...args) => {
      requests += 1
      return passingFetch(...args)
    },
  })
  assert.equal(requests, 9)
})

test('the final readiness gate includes Discord identity, guild, channel, permissions, and all game roles', async () => {
  const environment = {
    ...Object.fromEntries(REQUIRED_WEB_ENV.map((name) => [name, `test-${name.toLowerCase()}`])),
    ...Object.fromEntries(NIGHTRAID_GAME_ROLE_ENV_NAMES.map((name, index) => [name, `role-game-${index + 1}`])),
    ADMIN_DISCORD_IDS: NIGHTRAID_ADMIN_DISCORD_IDS.join(','),
    APP_URL: NIGHTRAID_APP_ORIGIN,
    DISCORD_APPLICATIONS_CHANNEL_ID: NIGHTRAID_REVIEW_CHANNEL_ID,
    DISCORD_BOT_TOKEN: `${Buffer.from(NIGHTBUDDY_APPLICATION_ID).toString('base64url')}.${'B'.repeat(6)}.${'C'.repeat(38)}`,
    DISCORD_CLIENT_ID: NIGHTBUDDY_APPLICATION_ID,
    DISCORD_GUILD_ID: NIGHTRAID_GUILD_ID,
    DISCORD_REDIRECT_URI: NIGHTRAID_DISCORD_CALLBACK,
  }
  const gameRoles = NIGHTRAID_GAME_ROLE_ENV_NAMES.map((name, index) => ({
    id: environment[name],
    name: `Game ${index + 1}`,
    permissions: '0',
    position: index + 1,
    managed: false,
  }))
  const discordPayloads = {
    '/users/@me': { id: NIGHTBUDDY_APPLICATION_ID },
    '/users/@me/guilds': [{ id: NIGHTRAID_GUILD_ID }],
    [`/guilds/${NIGHTRAID_GUILD_ID}/roles`]: [
      { id: NIGHTRAID_GUILD_ID, permissions: '0', position: 0, managed: false },
      ...gameRoles,
      { id: 'role-bot', permissions: '8', position: 20, managed: true },
    ],
    [`/guilds/${NIGHTRAID_GUILD_ID}/members/${NIGHTBUDDY_APPLICATION_ID}`]: { roles: ['role-bot'] },
    [`/channels/${NIGHTRAID_REVIEW_CHANNEL_ID}`]: {
      id: NIGHTRAID_REVIEW_CHANNEL_ID,
      guild_id: NIGHTRAID_GUILD_ID,
      type: 0,
      permission_overwrites: [],
    },
  }
  const fetchImpl = async (input) => {
    const url = new URL(String(input))
    if (url.pathname.startsWith('/api/v10/')) {
      const path = url.pathname.replace('/api/v10', '')
      return Response.json(discordPayloads[path] ?? { message: 'Not found' }, {
        status: discordPayloads[path] === undefined ? 404 : 200,
      })
    }
    return passingFetch(input)
  }

  assert.deepEqual(await validateProductionReadiness({
    attempts: 1,
    intervalMs: 0,
    environment,
    fetchImpl,
  }), [])
})
