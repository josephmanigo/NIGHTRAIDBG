import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { installApplicationReview } from '../bot/application-review.js'
import {
  NIGHTBUDDY_APPLICATION_ID,
  NIGHTRAID_ADMIN_DISCORD_IDS,
  NIGHTRAID_APP_ORIGIN,
  NIGHTRAID_GUILD_ID,
  NIGHTRAID_REVIEW_CHANNEL_ID,
} from '../bot/production-contract.js'

// Run the real server graph with Node's TypeScript support. Production keeps
// its bundler-compatible .js imports; only this test resolves them to sources.
const sourceRoots = ['../server/', '../handlers/'].map((path) => new URL(path, import.meta.url).href)
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {
      const source = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL)
      if (sourceRoots.some((root) => source.href.startsWith(root)) && existsSync(source)) {
        return nextResolve(source.href, context)
      }
    }
    return nextResolve(specifier, context)
  },
})
const { default: applicationAction } = await import('../handlers/discord/application-action.ts')
const { onboardApprovedApplication } = await import('../server/discord-onboarding.ts')
const { encryptSecret } = await import('../server/encryption.ts')
hook.deregister()

const APPLICATION_ID = '11111111-1111-4111-8111-111111111111'
const APPLICANT_ID = '100000000000000001'
const BLOODSTRIKE_ROLE = '1285794553915244574'
const BLOODSTRIKE_PLAYER_ROLE = '200000000000000001'
const ML_ROLE = '200000000000000002'
const EXISTING_ROLE = '200000000000000003'
const guildRoles = [
  { id: BLOODSTRIKE_ROLE, name: 'Night Striker', managed: false, position: 2 },
  { id: ML_ROLE, name: 'MLBB', managed: false, position: 3 },
  { id: BLOODSTRIKE_PLAYER_ROLE, name: 'BLOODSTRIKE PLAYERS', managed: false, position: 1 },
]
const environment = {
  SUPABASE_URL: 'https://onboarding.test',
  SUPABASE_SECRET_KEY: 'fixture-supabase-key',
  DISCORD_BOT_TOKEN: 'fixture-bot-token',
  DISCORD_CLIENT_ID: NIGHTBUDDY_APPLICATION_ID,
  DISCORD_CLIENT_SECRET: 'fixture-client-secret',
  DISCORD_GUILD_ID: NIGHTRAID_GUILD_ID,
  DISCORD_ROLE_BLOODSTRIKE_ID: BLOODSTRIKE_ROLE,
  DISCORD_ROLE_MOBILE_LEGENDS_ID: ML_ROLE,
  DISCORD_APPLICATIONS_CHANNEL_ID: NIGHTRAID_REVIEW_CHANNEL_ID,
  ADMIN_DISCORD_IDS: NIGHTRAID_ADMIN_DISCORD_IDS.join(','),
  APP_URL: NIGHTRAID_APP_ORIGIN,
  APPLICATION_SIGNING_SECRET: 'fixture-signing-secret',
  TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32),
  GOOGLE_SERVICE_ACCOUNT_EMAIL: '',
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: '',
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

async function scenario(t, options, run) {
  const previous = Object.fromEntries(Object.keys(environment).map((name) => [name, process.env[name]]))
  Object.assign(process.env, environment)
  if (options.configuredBloodstrikeRole) process.env.DISCORD_ROLE_BLOODSTRIKE_ID = options.configuredBloodstrikeRole
  const state = {
    application: {
      id: APPLICATION_ID,
      application_number: 'NR-2026-TEST01',
      discord_user_id: APPLICANT_ID,
      in_game_name: 'Applicant',
      games: options.games ?? ['Bloodstrike'],
      status: options.status ?? 'PENDING_REVIEW',
      discord_onboarding_status: options.onboardingStatus ?? 'NOT_STARTED',
      assigned_discord_roles: [],
      discord_membership_verified: !options.newMember,
    },
    member: options.newMember ? null : { user: { id: APPLICANT_ID }, roles: [...(options.initialRoles ?? [EXISTING_ROLE])] },
    calls: [], updates: [], logs: [], errors: [], unexpected: [], cards: [], replies: [], messages: [],
    tokenReads: 0, memberReads: 0, roleWrites: [], joinCalls: 0, apiPayload: null,
  }
  t.mock.method(console, 'error', (...values) => state.errors.push(values.join(' ')))
  t.mock.method(console, 'log', () => {})
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    const method = init.method ?? 'GET'
    const path = url.pathname
    state.calls.push(`${method} ${path}`)

    // The actual Discord button signs this request, and the actual API handler
    // validates it and runs approval, onboarding and persistence.
    if (url.origin === NIGHTRAID_APP_ORIGIN && path === '/api/discord/application-action') {
      const response = {
        statusCode: 200,
        setHeader() {},
        status(code) { this.statusCode = code; return this },
        json(payload) { this.payload = payload; return this },
      }
      await applicationAction({ method, headers: init.headers, body: init.body }, response)
      state.apiPayload = response.payload
      return json(response.payload, response.statusCode)
    }

    if (url.origin === environment.SUPABASE_URL) {
      if (path.startsWith('/storage/v1/object/nightraid-excel/')) return json({ Key: 'NIGHTRAID_Applicants.xlsx' })
      const body = init.body ? JSON.parse(init.body) : null
      if (path === '/rest/v1/rpc/decide_clan_application') {
        assert.equal(body.p_application_id, APPLICATION_ID)
        if (state.application.status !== 'PENDING_REVIEW') {
          return json({ code: 'P0001', message: 'APPLICATION_NOT_PENDING' }, 400)
        }
        state.application.status = body.p_decision
        return json(state.application)
      }
      if (path === '/rest/v1/clan_applications') {
        if (method === 'PATCH') {
          if (body.discord_onboarding_status === 'PROCESSING') {
            assert.equal(url.searchParams.get('id'), `eq.${APPLICATION_ID}`)
            assert.equal(url.searchParams.get('status'), 'in.(APPROVED,DISCORD_JOIN_FAILED)')
            assert.equal(url.searchParams.get('discord_onboarding_status'), 'in.(NOT_STARTED,FAILED)')
            if (!['APPROVED', 'DISCORD_JOIN_FAILED'].includes(state.application.status)
              || !['NOT_STARTED', 'FAILED'].includes(state.application.discord_onboarding_status)) return json(null)
          }
          state.updates.push(body)
          Object.assign(state.application, body)
          return url.searchParams.has('select') ? json(state.application) : new Response(null, { status: 204 })
        }
        // Export reads return an empty register; applicant-specific reads retain
        // the persisted state used by the API's recovery response.
        return json(url.searchParams.has('id') ? [state.application] : [])
      }
      if (path === '/rest/v1/discord_connections') {
        state.tokenReads += 1
        if (!options.oauth) return json([])
        return json([{
          encrypted_access_token: encryptSecret('fixture-access-token'),
          encrypted_refresh_token: encryptSecret('fixture-refresh-token'),
          token_expires_at: '2099-01-01T00:00:00.000Z',
        }])
      }
      if (path === '/rest/v1/discord_onboarding_logs') {
        state.logs.push(body)
        return new Response(null, { status: 201 })
      }
      if (['/rest/v1/security_audit_logs', '/rest/v1/excel_exports'].includes(path)) return new Response(null, { status: 201 })
    }

    if (url.origin === 'https://discord.com') {
      const memberPath = `/api/v10/guilds/${NIGHTRAID_GUILD_ID}/members/${APPLICANT_ID}`
      if (path === `/api/v10/guilds/${NIGHTRAID_GUILD_ID}/roles`) return json(options.guildRoles ?? guildRoles)
      if (path === '/api/v10/users/@me') return json({ id: NIGHTBUDDY_APPLICATION_ID })
      if (path === '/api/v10/oauth2/@me') return json({
        application: { id: NIGHTBUDDY_APPLICATION_ID }, user: { id: APPLICANT_ID }, scopes: ['identify', 'guilds.join'],
      })
      if (path === memberPath && method === 'GET') {
        state.memberReads += 1
        if (options.leaveAfterRoleWrite && state.roleWrites.length > 0) state.member = null
        if (options.memberReadError) return json({ code: 50001, message: 'Missing Access' }, 403)
        return state.member ? json(state.member) : json({ code: 10007, message: 'Unknown Member' }, 404)
      }
      if (path === memberPath && method === 'PUT') {
        state.joinCalls += 1
        if (options.concurrentJoin) state.member = { user: { id: APPLICANT_ID }, roles: [EXISTING_ROLE] }
        if (state.member) return new Response(null, { status: 204 })
        const body = JSON.parse(init.body)
        state.member = { user: { id: APPLICANT_ID }, roles: options.ignoreJoinRoles ? [] : [...body.roles] }
        return json(state.member, 201)
      }
      if (path.startsWith(`${memberPath}/roles/`) && method === 'PUT') {
        const role = path.split('/').at(-1)
        state.roleWrites.push(role)
        assert.equal(new Headers(init.headers).get('authorization'), `Bot ${environment.DISCORD_BOT_TOKEN}`)
        if (options.roleError === role) return json({ code: 50013, message: 'Missing Permissions' }, 403)
        if (!options.ignoreRoleWrites) state.member.roles = [...new Set([...state.member.roles, role])]
        return new Response(null, { status: 204 })
      }
      if (path === memberPath && method === 'PATCH') return json(state.member)
      if (path === '/api/v10/users/@me/channels') return json({ id: 'fixture-dm' })
      if (path === '/api/v10/channels/fixture-dm/messages') {
        state.messages.push(JSON.parse(init.body))
        return new Response(null, { status: options.dmFailure ? 403 : 200 })
      }
    }
    state.unexpected.push(`${method} ${url.origin}${path}`)
    return json({ message: 'Unexpected fixture request' }, 400)
  })

  state.accept = async () => {
    let listener
    installApplicationReview({ on(_event, callback) { listener = callback } })
    assert.equal(typeof listener, 'function')
    const interaction = {
      isButton: () => true, isModalSubmit: () => false,
      customId: `nr-review:approve:${APPLICATION_ID}`,
      channelId: NIGHTRAID_REVIEW_CHANNEL_ID,
      user: { id: NIGHTRAID_ADMIN_DISCORD_IDS[0], username: 'reviewer' },
      message: { content: 'Applicant review', embeds: [], edit: async (payload) => state.cards.push(payload) },
      deferReply: async () => { interaction.deferred = true },
      editReply: async (payload) => state.replies.push(payload),
    }
    await listener(interaction)
  }

  try {
    await run(state)
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    assert.deepEqual(state.unexpected, [], 'all external calls must use the fixture; no live requests')
  }
}

test('Discord Accept assigns roles to an existing member without a saved OAuth connection', async (t) => {
  await scenario(t, {}, async (state) => {
    await state.accept()
    assert.equal(state.application.status, 'COMPLETED', state.application.discord_onboarding_error)
    assert.deepEqual(state.member.roles, [EXISTING_ROLE, BLOODSTRIKE_ROLE])
    assert.equal(state.tokenReads, 0)
    assert.equal(state.joinCalls, 0)
    assert.deepEqual(state.application.assigned_discord_roles, ['Night Striker'])
    assert.equal(state.apiPayload.onboardingStatus, 'COMPLETED')
    assert.match(state.cards[0].content, /roles verified/i)
  })
})

test('Discord Accept repairs missing roles after a successful new-member join', async (t) => {
  await scenario(t, { newMember: true, oauth: true, ignoreJoinRoles: true }, async (state) => {
    await state.accept()
    assert.ok(state.member.roles.includes(BLOODSTRIKE_ROLE), 'COMPLETED requires the actual selected role')
    assert.equal(state.application.status, 'COMPLETED')
    assert.equal(state.joinCalls, 1)
    assert.ok(state.memberReads >= 2)
  })
})

test('Discord Accept reports failure when successful role requests leave the role missing', async (t) => {
  await scenario(t, { oauth: true, ignoreRoleWrites: true }, async (state) => {
    await state.accept()
    assert.equal(state.application.status, 'DISCORD_JOIN_FAILED')
    assert.deepEqual(state.application.assigned_discord_roles, [])
    assert.match(state.application.discord_onboarding_error, /not.*verified|missing/i)
    assert.equal(state.apiPayload.onboardingStatus, 'DISCORD_JOIN_FAILED')
    assert.match(state.cards[0].content, /roles need attention/i)
    assert.match(state.replies[0].content, /^⚠️/u)
    assert.ok(!state.updates.some((update) => update.discord_onboarding_status === 'COMPLETED'))
    assert.ok(!state.messages.some((message) => message.content.includes('Your selected game roles are ready.')))
  })
})

test('an administrator retry can finish a failed application whose role was added manually', async (t) => {
  await scenario(t, {
    status: 'DISCORD_JOIN_FAILED', onboardingStatus: 'FAILED', initialRoles: [EXISTING_ROLE, BLOODSTRIKE_ROLE],
  }, async (state) => {
    const result = await onboardApprovedApplication(APPLICATION_ID)
    assert.equal(result.status, 'COMPLETED', result.error)
    assert.deepEqual(state.roleWrites, [])
    assert.equal(state.tokenReads, 0)
    assert.deepEqual(state.member.roles, [EXISTING_ROLE, BLOODSTRIKE_ROLE])
  })
})

test('Discord Accept verifies both selected game roles while preserving manually assigned roles', async (t) => {
  await scenario(t, { games: ['Bloodstrike', 'Mobile Legends'], initialRoles: [EXISTING_ROLE, BLOODSTRIKE_ROLE] }, async (state) => {
    await state.accept()
    assert.equal(state.application.status, 'COMPLETED', state.application.discord_onboarding_error)
    assert.deepEqual(state.roleWrites, [ML_ROLE])
    assert.deepEqual(state.member.roles, [EXISTING_ROLE, BLOODSTRIKE_ROLE, ML_ROLE])
    assert.deepEqual(state.application.assigned_discord_roles, ['Night Striker', 'MLBB'])
    assert.deepEqual(state.apiPayload.assignedRoles, state.application.assigned_discord_roles)
    assert.equal(state.messages.length, 1)
    assert.match(state.messages[0].content, /Your selected game roles are ready/)
  })
})

test('a new member joins with OAuth and completes only after roles are read back', async (t) => {
  await scenario(t, { newMember: true, oauth: true }, async (state) => {
    await state.accept()
    assert.equal(state.application.status, 'COMPLETED', state.application.discord_onboarding_error)
    assert.equal(state.joinCalls, 1)
    assert.equal(state.tokenReads, 1)
    assert.deepEqual(state.roleWrites, [])
    assert.deepEqual(state.member.roles, [BLOODSTRIKE_ROLE])
    assert.ok(state.memberReads >= 2)
    assert.equal(state.logs.at(-1).status, 'COMPLETED')
  })
})

test('a concurrent manual join returning 204 still receives the selected role', async (t) => {
  await scenario(t, { newMember: true, oauth: true, concurrentJoin: true }, async (state) => {
    await state.accept()
    assert.equal(state.application.status, 'COMPLETED', state.application.discord_onboarding_error)
    assert.deepEqual(state.member.roles, [EXISTING_ROLE, BLOODSTRIKE_ROLE])
    assert.deepEqual(state.roleWrites, [BLOODSTRIKE_ROLE])
  })
})

test('an absent member without OAuth stays accepted but cannot be marked onboarded', async (t) => {
  await scenario(t, { newMember: true }, async (state) => {
    await state.accept()
    assert.equal(state.apiPayload.decision, 'APPROVED')
    assert.equal(state.application.status, 'DISCORD_JOIN_FAILED')
    assert.equal(state.application.discord_membership_verified, false)
    assert.match(state.application.discord_onboarding_error, /reconnect Discord/)
    assert.deepEqual(state.roleWrites, [])
    assert.equal(state.joinCalls, 0)
    assert.match(state.cards[0].content, /roles need attention/i)
    assert.equal(state.messages.length, 0)
  })
})

test('a role permission failure records verified partial success and retries only the missing role', async (t) => {
  const options = { games: ['Bloodstrike', 'Mobile Legends'], roleError: ML_ROLE }
  await scenario(t, options, async (state) => {
    await state.accept()
    assert.equal(state.application.status, 'DISCORD_JOIN_FAILED')
    assert.match(state.application.discord_onboarding_error, /Missing Permissions/)
    assert.deepEqual(state.application.assigned_discord_roles, ['Night Striker'])
    assert.equal(state.logs.at(-1).status, 'FAILED')
    assert.deepEqual(state.logs.at(-1).assigned_roles, ['Night Striker'])
    assert.match(state.cards[0].content, /roles need attention/i)
    options.roleError = null
    const result = await onboardApprovedApplication(APPLICATION_ID)
    assert.equal(result.status, 'COMPLETED', result.error)
    assert.deepEqual(state.roleWrites, [BLOODSTRIKE_ROLE, ML_ROLE, ML_ROLE])
    assert.deepEqual(state.member.roles, [EXISTING_ROLE, BLOODSTRIKE_ROLE, ML_ROLE])
    assert.equal(state.tokenReads, 0)
  })
})

test('a failed member lookup does not attempt OAuth joining or role changes', async (t) => {
  await scenario(t, { memberReadError: true }, async (state) => {
    await state.accept()
    assert.equal(state.application.status, 'DISCORD_JOIN_FAILED')
    assert.match(state.application.discord_onboarding_error, /Missing Access/)
    assert.equal(state.tokenReads, 0)
    assert.equal(state.joinCalls, 0)
    assert.deepEqual(state.roleWrites, [])
  })
})

test('a configured role missing from the guild fails without assigning another role', async (t) => {
  await scenario(t, { guildRoles: [guildRoles[1]] }, async (state) => {
    await state.accept()
    assert.equal(state.application.status, 'DISCORD_JOIN_FAILED')
    assert.match(state.application.discord_onboarding_error, /Night Striker.*1285794553915244574/)
    assert.deepEqual(state.roleWrites, [])
    assert.deepEqual(state.member.roles, [EXISTING_ROLE])
  })
})

test('a member leaving during assignment cannot produce completed onboarding', async (t) => {
  await scenario(t, { leaveAfterRoleWrite: true }, async (state) => {
    await state.accept()
    assert.equal(state.application.status, 'DISCORD_JOIN_FAILED')
    assert.equal(state.application.discord_membership_verified, false)
    assert.deepEqual(state.application.assigned_discord_roles, [])
    assert.match(state.application.discord_onboarding_error, /left.*server/i)
    assert.equal(state.messages.length, 0)
  })
})

test('a repeated Discord Accept cannot repeat completed onboarding', async (t) => {
  await scenario(t, {}, async (state) => {
    await state.accept()
    assert.equal(state.application.status, 'COMPLETED')
    await state.accept()
    assert.deepEqual(state.roleWrites, [BLOODSTRIKE_ROLE])
    assert.equal(state.messages.length, 1)
    assert.equal(state.cards.length, 1)
    assert.match(state.replies.at(-1).content, /already decided/i)
  })
})

test('completed or processing onboarding cannot be claimed by a retry', async (t) => {
  for (const onboardingStatus of ['PROCESSING', 'COMPLETED']) {
    await scenario(t, { status: 'APPROVED', onboardingStatus }, async (state) => {
      await assert.rejects(() => onboardApprovedApplication(APPLICATION_ID), /already complete or in progress/)
      assert.deepEqual(state.roleWrites, [])
      assert.equal(state.memberReads, 0)
    })
  }
})

test('an application without selected games cannot report successful role assignment', async (t) => {
  await scenario(t, { games: [] }, async (state) => {
    await state.accept()
    assert.equal(state.application.status, 'DISCORD_JOIN_FAILED')
    assert.match(state.application.discord_onboarding_error, /no selected.*roles/i)
    assert.deepEqual(state.roleWrites, [])
  })
})

test('Discord Accept assigns Night Striker even when the player role exists and its old ID is configured', async (t) => {
  await scenario(t, {
    initialRoles: [EXISTING_ROLE, BLOODSTRIKE_PLAYER_ROLE],
    configuredBloodstrikeRole: BLOODSTRIKE_PLAYER_ROLE,
  }, async (state) => {
    await state.accept()
    assert.equal(state.application.status, 'COMPLETED', state.application.discord_onboarding_error)
    assert.deepEqual(state.roleWrites, ['1285794553915244574'])
    assert.ok(state.member.roles.includes('1285794553915244574'))
    assert.deepEqual(state.application.assigned_discord_roles, ['Night Striker'])
    assert.deepEqual(state.apiPayload.assignedRoles, ['Night Striker'])
  })
})
