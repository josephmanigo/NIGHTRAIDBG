import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  REQUIRED_WEB_ENV,
  deploymentPreflightDecision,
  discordBotApplicationId,
  missingWebEnvironment,
  validateDiscordLiveEnvironment,
  validateWebEnvironment,
} from '../scripts/vercel-web-env-preflight.mjs'
import { NIGHTRAID_GAME_ROLE_ENV_NAMES } from '../bot/production-contract.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const script = resolve(root, 'scripts/vercel-web-env-preflight.mjs')

const DISCORD_PERMISSIONS = {
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  EMBED_LINKS: 1n << 14n,
  ATTACH_FILES: 1n << 15n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  MANAGE_NICKNAMES: 1n << 27n,
  MANAGE_ROLES: 1n << 28n,
}

function permissionMask(...names) {
  return names.reduce((mask, name) => mask | DISCORD_PERMISSIONS[name], 0n).toString()
}

function completeEnvironment() {
  const discordClientId = '1529891839484628997'
  return {
    ...Object.fromEntries(REQUIRED_WEB_ENV.map((name) => [name, `test-${name.toLowerCase()}`])),
    ...Object.fromEntries(NIGHTRAID_GAME_ROLE_ENV_NAMES.map((name, index) => [name, `role-game-${index + 1}`])),
    ADMIN_DISCORD_IDS: '433544969782034442,294888876940460033',
    APP_URL: 'https://www.nightraidbg.org',
    DISCORD_APPLICATIONS_CHANNEL_ID: '1530202289565077636',
    DISCORD_BOT_TOKEN: `${Buffer.from(discordClientId).toString('base64url')}.${'B'.repeat(6)}.${'C'.repeat(38)}`,
    DISCORD_CLIENT_ID: discordClientId,
    DISCORD_GUILD_ID: '1208444297926545489',
    DISCORD_REDIRECT_URI: 'https://www.nightraidbg.org/api/auth/discord/callback',
  }
}

function discordFixture(overrides = {}) {
  const environment = completeEnvironment()
  environment.DISCORD_ROLE_MOBILE_LEGENDS_ID = 'role-mobile'
  const configuredGameRoles = NIGHTRAID_GAME_ROLE_ENV_NAMES
    .map((name, index) => ({
      id: environment[name],
      name: `Configured Game ${index + 1}`,
      permissions: '0',
      position: index + 1,
      managed: false,
    }))
    .filter((role) => role.id !== 'role-mobile')
  const payloads = {
    '/users/@me': { id: environment.DISCORD_CLIENT_ID },
    '/users/@me/guilds': [{ id: environment.DISCORD_GUILD_ID }],
    [`/guilds/${environment.DISCORD_GUILD_ID}/roles`]: [
      {
        id: environment.DISCORD_GUILD_ID,
        name: '@everyone',
        permissions: permissionMask('VIEW_CHANNEL', 'SEND_MESSAGES'),
        position: 0,
        managed: false,
      },
      { id: 'role-mobile', name: 'Mobile Legends: Bang Bang', permissions: '0', position: 2, managed: false },
      ...configuredGameRoles,
      {
        id: 'role-bot',
        name: 'NIGHTBUDDY',
        permissions: permissionMask(
          'MANAGE_NICKNAMES',
          'MANAGE_ROLES',
          'READ_MESSAGE_HISTORY',
          'EMBED_LINKS',
          'ATTACH_FILES',
        ),
        position: 10,
        managed: true,
      },
    ],
    [`/guilds/${environment.DISCORD_GUILD_ID}/members/${environment.DISCORD_CLIENT_ID}`]: {
      roles: ['role-bot'],
    },
    [`/channels/${environment.DISCORD_APPLICATIONS_CHANNEL_ID}`]: {
      id: environment.DISCORD_APPLICATIONS_CHANNEL_ID,
      guild_id: environment.DISCORD_GUILD_ID,
      type: 0,
      permission_overwrites: [],
    },
    ...overrides,
  }
  const fetchImpl = async (input) => {
    const path = new URL(String(input)).pathname.replace('/api/v10', '')
    const payload = payloads[path]
    if (payload instanceof Response) return payload
    if (payload === undefined) return Response.json({ message: 'Unknown fixture path' }, { status: 404 })
    return Response.json(payload)
  }
  return { environment, fetchImpl }
}

test('the production contract requires a Discord application-review channel', () => {
  assert.ok(
    REQUIRED_WEB_ENV.includes('DISCORD_APPLICATIONS_CHANNEL_ID'),
    'A production deployment must not silently skip Discord application review cards',
  )
})

test('the environment template documents every Vercel web prerequisite', () => {
  const template = readFileSync(resolve(root, '.env.example'), 'utf8')
  const documented = new Set(
    template
      .split(/\r?\n/)
      .map((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
      .filter(Boolean),
  )

  assert.deepEqual(
    REQUIRED_WEB_ENV.filter((name) => !documented.has(name)),
    [],
    '.env.example must not omit server variables required by the deployed web application',
  )
})

test('the preflight reports every missing prerequisite without reading secret values', () => {
  assert.deepEqual(missingWebEnvironment({}), REQUIRED_WEB_ENV)
  assert.deepEqual(validateWebEnvironment(completeEnvironment()), [])
})

test('the preflight rejects a Discord callback on a different origin or path', () => {
  const wrongOrigin = completeEnvironment()
  wrongOrigin.DISCORD_REDIRECT_URI = 'https://preview.example/api/auth/discord/callback'
  assert.match(validateWebEnvironment(wrongOrigin).join('\n'), /must use APP_URL/)

  const wrongPath = completeEnvironment()
  wrongPath.DISCORD_REDIRECT_URI = 'https://www.nightraidbg.org/callback'
  assert.match(validateWebEnvironment(wrongPath).join('\n'), /must use APP_URL/)
})

test('the preflight pins the production website, callback, review channel, and administrators', () => {
  const wrong = completeEnvironment()
  wrong.APP_URL = 'https://nightraidbg.org'
  wrong.DISCORD_REDIRECT_URI = 'https://nightraidbg.org/api/auth/discord/callback'
  wrong.DISCORD_APPLICATIONS_CHANNEL_ID = '1530202289565077637'
  wrong.ADMIN_DISCORD_IDS = 'not-a-discord-id'

  const problems = validateWebEnvironment(wrong).join('\n')
  assert.match(problems, /production website origin/)
  assert.match(problems, /production Discord callback/)
  assert.match(problems, /application review channel/)
  assert.match(problems, /authorized NIGHTRAID administrator/)
})

test('the preflight rejects a placeholder Discord bot token before production deploys', () => {
  const environment = completeEnvironment()
  environment.DISCORD_BOT_TOKEN = 'placeholder'

  assert.match(validateWebEnvironment(environment).join('\n'), /DISCORD_BOT_TOKEN does not look like a complete bot token/)
})

test('the preflight proves the bot token and OAuth client belong to the same Discord application', () => {
  const environment = completeEnvironment()
  assert.equal(discordBotApplicationId(environment.DISCORD_BOT_TOKEN), environment.DISCORD_CLIENT_ID)

  environment.DISCORD_CLIENT_ID = '1529891839484628998'
  assert.match(
    validateWebEnvironment(environment).join('\n'),
    /DISCORD_BOT_TOKEN and DISCORD_CLIENT_ID belong to different Discord applications/,
  )
})

test('the production contract rejects a coherent but wrong Discord application or guild', () => {
  const wrongApplication = completeEnvironment()
  wrongApplication.DISCORD_CLIENT_ID = '1529891839484628998'
  wrongApplication.DISCORD_BOT_TOKEN = `${Buffer.from(wrongApplication.DISCORD_CLIENT_ID).toString('base64url')}.${'B'.repeat(6)}.${'C'.repeat(38)}`
  assert.match(validateWebEnvironment(wrongApplication).join('\n'), /must be the NIGHTBUDDY application/)

  const wrongGuild = completeEnvironment()
  wrongGuild.DISCORD_GUILD_ID = '1208600000000000000'
  assert.match(validateWebEnvironment(wrongGuild).join('\n'), /must be the NIGHTRAID BATTLEGROUND server/)
})

test('the live Discord preflight proves bot, guild, review-channel, permission, and role readiness', async () => {
  const fixture = discordFixture()
  assert.deepEqual(await validateDiscordLiveEnvironment(fixture.environment, fixture.fetchImpl), [])
})

test('the live Discord preflight requires history, embeds, and attachments in the review channel', async () => {
  const base = discordFixture()
  const guildId = base.environment.DISCORD_GUILD_ID
  const channelId = base.environment.DISCORD_APPLICATIONS_CHANNEL_ID
  const fixture = discordFixture({
    [`/channels/${channelId}`]: {
      id: channelId,
      guild_id: guildId,
      type: 0,
      permission_overwrites: [{
        id: guildId,
        type: 0,
        allow: '0',
        deny: permissionMask('READ_MESSAGE_HISTORY', 'EMBED_LINKS', 'ATTACH_FILES'),
      }],
    },
  })
  const problems = await validateDiscordLiveEnvironment(fixture.environment, fixture.fetchImpl)
  assert.match(problems.join('\n'), /Read Message History/)
  assert.match(problems.join('\n'), /Embed Links/)
  assert.match(problems.join('\n'), /Attach Files/)
})

test('the live Discord preflight reports a rejected bot token without exposing it', async () => {
  const fixture = discordFixture({
    '/users/@me': Response.json({ message: '401: Unauthorized', code: 0 }, { status: 401 }),
  })
  const problems = await validateDiscordLiveEnvironment(fixture.environment, fixture.fetchImpl)
  assert.match(problems.join('\n'), /DISCORD_BOT_TOKEN was rejected by Discord/)
  assert.doesNotMatch(problems.join('\n'), new RegExp(fixture.environment.DISCORD_BOT_TOKEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('the live Discord preflight distinguishes a bot that is not installed in the configured guild', async () => {
  const fixture = discordFixture({ '/users/@me/guilds': [] })
  const problems = await validateDiscordLiveEnvironment(fixture.environment, fixture.fetchImpl)
  assert.match(
    problems.join('\n'),
    /bot is not installed in DISCORD_GUILD_ID.*Invite this same Discord application/i,
  )
})

test('mutable Discord readiness problems warn without blocking a production website deployment', () => {
  assert.deepEqual(
    deploymentPreflightDecision([], ['The Discord bot is not installed in DISCORD_GUILD_ID']),
    {
      blockingProblems: [],
      readinessWarnings: ['The Discord bot is not installed in DISCORD_GUILD_ID'],
      canDeploy: true,
    },
  )
})

test('missing or contradictory environment credentials still block deployment', () => {
  assert.deepEqual(
    deploymentPreflightDecision(['Missing required Vercel environment variable: DISCORD_CLIENT_ID'], []),
    {
      blockingProblems: ['Missing required Vercel environment variable: DISCORD_CLIENT_ID'],
      readinessWarnings: [],
      canDeploy: false,
    },
  )
})

test('the live Discord preflight fails closed on guild, channel, permission, and role hierarchy errors', async () => {
  const base = discordFixture()
  const guildId = base.environment.DISCORD_GUILD_ID
  const channelId = base.environment.DISCORD_APPLICATIONS_CHANNEL_ID
  const fixture = discordFixture({
    [`/guilds/${guildId}/roles`]: [
      { id: guildId, name: '@everyone', permissions: '0', position: 0, managed: false },
      { id: 'role-bot', name: 'NIGHTRAID Bot', permissions: '0', position: 1, managed: true },
      { id: 'role-mobile', name: 'Mobile Legends: Bang Bang', permissions: '0', position: 2, managed: false },
    ],
    [`/channels/${channelId}`]: {
      id: channelId,
      guild_id: 'another-guild',
      type: 0,
      permission_overwrites: [],
    },
  })
  const problems = await validateDiscordLiveEnvironment(fixture.environment, fixture.fetchImpl)
  assert.match(problems.join('\n'), /review channel is not in DISCORD_GUILD_ID/)
  assert.match(problems.join('\n'), /Manage Roles/)
  assert.match(problems.join('\n'), /Manage Nicknames/)
  assert.match(problems.join('\n'), /cannot view and send messages/)
  assert.match(problems.join('\n'), /must be above the configured role/)
})

test('the Vercel preflight process fails closed when credentials are missing', () => {
  const result = spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: 'utf8',
    env: { VERCEL: '1', VERCEL_ENV: 'production' },
  })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /DISCORD_CLIENT_ID/)
  assert.match(result.stderr, /TOKEN_ENCRYPTION_KEY/)
})

test('the Vercel preflight process passes with a complete, coherent environment', () => {
  const result = spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: 'utf8',
    env: { VERCEL: '1', VERCEL_ENV: 'production', NODE_ENV: 'test', ...completeEnvironment() },
  })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /preflight passed/)
})

test('the preflight does not require production credentials in a preview build', () => {
  const result = spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: 'utf8',
    env: { VERCEL: '1', VERCEL_ENV: 'preview' },
  })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /non-production Vercel build/)
})
