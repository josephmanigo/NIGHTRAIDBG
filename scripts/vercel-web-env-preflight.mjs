import {
  discordBotApplicationId,
  NIGHTRAID_GAME_ROLE_ENV_NAMES,
  productionDiscordContractProblems,
} from '../bot/production-contract.js'

const REQUIRED_WEB_ENV = [
  'SUPABASE_URL',
  'SUPABASE_SECRET_KEY',
  'DISCORD_CLIENT_ID',
  'DISCORD_CLIENT_SECRET',
  'DISCORD_REDIRECT_URI',
  'DISCORD_BOT_TOKEN',
  'DISCORD_GUILD_ID',
  'DISCORD_APPLICATIONS_CHANNEL_ID',
  ...NIGHTRAID_GAME_ROLE_ENV_NAMES,
  'SESSION_SECRET',
  'TOKEN_ENCRYPTION_KEY',
  'ADMIN_DISCORD_IDS',
  'APP_URL',
  'APPLICATION_SIGNING_SECRET',
  'GEMINI_API_KEY',
]

export function missingWebEnvironment(environment = process.env) {
  return REQUIRED_WEB_ENV.filter((name) => !environment[name]?.trim())
}

export function validateWebEnvironment(environment = process.env) {
  const missing = missingWebEnvironment(environment)
  const problems = missing.map((name) => `Missing required Vercel environment variable: ${name}`)
  problems.push(...productionDiscordContractProblems(environment))

  const appUrl = environment.APP_URL?.trim()
  const redirectUri = environment.DISCORD_REDIRECT_URI?.trim()
  const botToken = environment.DISCORD_BOT_TOKEN?.trim()
  const discordClientId = environment.DISCORD_CLIENT_ID?.trim()
  if (
    botToken &&
    (botToken.length < 50 || /^Bot\s/i.test(botToken) || /\s/.test(botToken) || /^['"`]|['"`]$/.test(botToken))
  ) {
    problems.push('DISCORD_BOT_TOKEN does not look like a complete bot token')
  }
  const botApplicationId = discordBotApplicationId(botToken)
  if (botApplicationId && discordClientId && botApplicationId !== discordClientId) {
    problems.push('DISCORD_BOT_TOKEN and DISCORD_CLIENT_ID belong to different Discord applications')
  }

  if (appUrl && redirectUri) {
    try {
      const appOrigin = new URL(appUrl).origin
      const redirect = new URL(redirectUri)
      if (redirect.origin !== appOrigin || redirect.pathname !== '/api/auth/discord/callback') {
        problems.push('DISCORD_REDIRECT_URI must use APP_URL and end with /api/auth/discord/callback')
      }
    } catch {
      problems.push('APP_URL and DISCORD_REDIRECT_URI must be valid absolute URLs')
    }
  }

  return problems
}

const DISCORD_API = 'https://discord.com/api/v10'
const ADMINISTRATOR = 1n << 3n
const VIEW_CHANNEL = 1n << 10n
const SEND_MESSAGES = 1n << 11n
const EMBED_LINKS = 1n << 14n
const ATTACH_FILES = 1n << 15n
const READ_MESSAGE_HISTORY = 1n << 16n
const MANAGE_NICKNAMES = 1n << 27n
const MANAGE_ROLES = 1n << 28n

function permissionBits(value) {
  try {
    return BigInt(value || '0')
  } catch {
    return 0n
  }
}

function hasPermission(permissions, permission) {
  return (permissions & ADMINISTRATOR) === ADMINISTRATOR || (permissions & permission) === permission
}

function applyOverwrite(permissions, overwrite) {
  return (permissions & ~permissionBits(overwrite?.deny)) | permissionBits(overwrite?.allow)
}

function channelPermissions(basePermissions, botUserId, memberRoleIds, permissionOverwrites = []) {
  if (hasPermission(basePermissions, ADMINISTRATOR)) return basePermissions

  let permissions = basePermissions
  const everyoneOverwrite = permissionOverwrites.find((overwrite) => overwrite.type === 0 && overwrite.id === memberRoleIds.guildId)
  if (everyoneOverwrite) permissions = applyOverwrite(permissions, everyoneOverwrite)

  let roleAllow = 0n
  let roleDeny = 0n
  for (const overwrite of permissionOverwrites) {
    if (overwrite.type !== 0 || !memberRoleIds.values.has(overwrite.id)) continue
    roleAllow |= permissionBits(overwrite.allow)
    roleDeny |= permissionBits(overwrite.deny)
  }
  permissions = (permissions & ~roleDeny) | roleAllow

  const memberOverwrite = permissionOverwrites.find((overwrite) => overwrite.type === 1 && overwrite.id === botUserId)
  return memberOverwrite ? applyOverwrite(permissions, memberOverwrite) : permissions
}

async function discordGet(path, environment, fetchImpl, label) {
  let response
  try {
    response = await fetchImpl(`${DISCORD_API}${path}`, {
      headers: { Authorization: `Bot ${environment.DISCORD_BOT_TOKEN.trim()}` },
      signal: AbortSignal.timeout(8_000),
    })
  } catch {
    throw new Error(`Discord could not be reached while checking ${label}`)
  }
  if (!response.ok) {
    if (path === '/users/@me' && response.status === 401) {
      throw new Error('DISCORD_BOT_TOKEN was rejected by Discord')
    }
    throw new Error(`Discord rejected the ${label} check with status ${response.status}`)
  }
  return response.json()
}

export async function validateDiscordLiveEnvironment(environment = process.env, fetchImpl = fetch) {
  const problems = []
  const guildId = environment.DISCORD_GUILD_ID?.trim()
  const channelId = environment.DISCORD_APPLICATIONS_CHANNEL_ID?.trim()
  const clientId = environment.DISCORD_CLIENT_ID?.trim()
  if (!environment.DISCORD_BOT_TOKEN?.trim() || !guildId || !channelId || !clientId) return problems
  const identityProblems = productionDiscordContractProblems(environment)
  if (identityProblems.length > 0) return identityProblems

  let bot
  let botGuilds
  let roles
  let member
  let channel
  try {
    bot = await discordGet('/users/@me', environment, fetchImpl, 'bot identity')
    if (bot.id !== clientId) {
      problems.push('Discord authenticated a bot from a different application than DISCORD_CLIENT_ID')
      return problems
    }
    botGuilds = await discordGet('/users/@me/guilds', environment, fetchImpl, 'bot guild list')
    if (!Array.isArray(botGuilds) || !botGuilds.some((guild) => guild.id === guildId)) {
      problems.push('The Discord bot is not installed in DISCORD_GUILD_ID. Invite this same Discord application to the NIGHTRAID server or correct DISCORD_GUILD_ID')
      return problems
    }
    ;[roles, member, channel] = await Promise.all([
      discordGet(`/guilds/${encodeURIComponent(guildId)}/roles`, environment, fetchImpl, 'guild roles'),
      discordGet(`/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(bot.id)}`, environment, fetchImpl, 'bot guild membership'),
      discordGet(`/channels/${encodeURIComponent(channelId)}`, environment, fetchImpl, 'application review channel'),
    ])
  } catch (reason) {
    problems.push(reason instanceof Error ? reason.message : 'Discord live configuration validation failed')
    return problems
  }

  if (!Array.isArray(roles) || !Array.isArray(member?.roles)) {
    return ['Discord returned an invalid guild role or bot membership response']
  }
  if (channel?.guild_id !== guildId) {
    problems.push('The Discord application review channel is not in DISCORD_GUILD_ID')
  }
  if (![0, 5].includes(channel?.type)) {
    problems.push('DISCORD_APPLICATIONS_CHANNEL_ID must reference a Discord text or announcement channel')
  }

  const memberRoleIds = new Set(member.roles)
  const assignedRoles = roles.filter((role) => role.id === guildId || memberRoleIds.has(role.id))
  const basePermissions = assignedRoles.reduce(
    (permissions, role) => permissions | permissionBits(role.permissions),
    0n,
  )
  if (!hasPermission(basePermissions, MANAGE_ROLES)) {
    problems.push('The Discord bot is missing Manage Roles in the configured guild')
  }
  if (!hasPermission(basePermissions, MANAGE_NICKNAMES)) {
    problems.push('The Discord bot is missing Manage Nicknames in the configured guild')
  }

  const effectiveChannelPermissions = channelPermissions(
    basePermissions,
    bot.id,
    { guildId, values: memberRoleIds },
    Array.isArray(channel?.permission_overwrites) ? channel.permission_overwrites : [],
  )
  if (!hasPermission(effectiveChannelPermissions, VIEW_CHANNEL) || !hasPermission(effectiveChannelPermissions, SEND_MESSAGES)) {
    problems.push('The Discord bot cannot view and send messages in DISCORD_APPLICATIONS_CHANNEL_ID')
  }
  for (const [permission, label] of [
    [READ_MESSAGE_HISTORY, 'Read Message History'],
    [EMBED_LINKS, 'Embed Links'],
    [ATTACH_FILES, 'Attach Files'],
  ]) {
    if (!hasPermission(effectiveChannelPermissions, permission)) {
      problems.push(`The Discord bot is missing ${label} in DISCORD_APPLICATIONS_CHANNEL_ID`)
    }
  }

  const botTopPosition = assignedRoles.reduce((position, role) => Math.max(position, role.position || 0), 0)
  for (const [name, value] of Object.entries(environment)) {
    if (!/^DISCORD_ROLE_[A-Z0-9_]+_ID$/.test(name) || !value?.trim()) continue
    const role = roles.find((candidate) => candidate.id === value.trim())
    if (!role) {
      problems.push(`${name} does not exist in DISCORD_GUILD_ID`)
    } else if (role.managed) {
      problems.push(`${name} references a managed Discord role that cannot be assigned`)
    } else if ((role.position || 0) >= botTopPosition) {
      problems.push(`The Discord bot's highest role must be above the configured role in ${name}`)
    }
  }

  return problems
}

export function deploymentPreflightDecision(blockingProblems, readinessWarnings) {
  return {
    blockingProblems,
    readinessWarnings,
    canDeploy: blockingProblems.length === 0,
  }
}

export { discordBotApplicationId, REQUIRED_WEB_ENV }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.env.VERCEL) {
    console.log('Skipping the Vercel web environment preflight outside Vercel.')
  } else if (process.env.VERCEL_ENV !== 'production') {
    console.log('Skipping production web credentials for a non-production Vercel build.')
  } else {
    const blockingProblems = validateWebEnvironment()
    const readinessWarnings = []
    if (blockingProblems.length === 0 && process.env.NODE_ENV !== 'test') {
      readinessWarnings.push(...await validateDiscordLiveEnvironment())
    }
    const decision = deploymentPreflightDecision(blockingProblems, readinessWarnings)
    if (!decision.canDeploy) {
      console.error([
        'Vercel production web deployment configuration is incomplete:',
        ...decision.blockingProblems.map((problem) => `- ${problem}`),
        'Restore the existing secret values before redeploying; do not generate a new TOKEN_ENCRYPTION_KEY if saved Discord connections must remain decryptable.',
      ].join('\n'))
      process.exitCode = 1
    } else {
      console.log('Vercel web environment preflight passed.')
      if (decision.readinessWarnings.length > 0) {
        console.warn([
          'Discord live readiness warning (website deployment will continue):',
          ...decision.readinessWarnings.map((problem) => `- ${problem}`),
          'Discord-dependent actions remain fail-closed until the server configuration is corrected.',
        ].join('\n'))
      }
    }
  }
}
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
