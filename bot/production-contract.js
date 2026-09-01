export const NIGHTBUDDY_APPLICATION_ID = '1529891839484628997'
export const NIGHTRAID_GUILD_ID = '1208444297926545489'
export const NIGHTRAID_REVIEW_CHANNEL_ID = '1530202289565077636'
export const NIGHTRAID_APP_ORIGIN = 'https://www.nightraidbg.org'
export const NIGHTRAID_DISCORD_CALLBACK = `${NIGHTRAID_APP_ORIGIN}/api/auth/discord/callback`
export const NIGHTBUDDY_READY_BODY = 'NIGHTBUDDY is ready.'
export const NIGHTRAID_ADMIN_DISCORD_IDS = Object.freeze([
  '433544969782034442',
  '294888876940460033',
])
export const NIGHTRAID_GAME_ROLE_ENV_NAMES = Object.freeze([
  'DISCORD_ROLE_BLOODSTRIKE_ID',
  'DISCORD_ROLE_MOBILE_LEGENDS_ID',
  'DISCORD_ROLE_HONOR_OF_KINGS_ID',
  'DISCORD_ROLE_FARLIGHT_ID',
  'DISCORD_ROLE_CROSSFIRE_ID',
  'DISCORD_ROLE_ROBLOX_ID',
  'DISCORD_ROLE_DOTA_2_ID',
  'DISCORD_ROLE_VALORANT_ID',
])

function trimmed(environment, name) {
  return environment[name]?.trim() || null
}

function isExactOrigin(value, expectedOrigin) {
  try {
    const url = new URL(value)
    return url.origin === expectedOrigin && url.pathname === '/' && !url.search && !url.hash
  } catch {
    return false
  }
}

function isExactUrl(value, expectedUrl) {
  try {
    return new URL(value).href === expectedUrl
  } catch {
    return false
  }
}

function hasExactAdminIds(value) {
  const ids = value
    .split(',')
    .map((candidate) => candidate.trim())
    .filter(Boolean)
  if (ids.some((id) => !/^\d{17,20}$/.test(id))) return false
  const actual = new Set(ids)
  return actual.size === NIGHTRAID_ADMIN_DISCORD_IDS.length
    && NIGHTRAID_ADMIN_DISCORD_IDS.every((id) => actual.has(id))
}

export function discordBotApplicationId(botToken) {
  const token = botToken?.trim()
  if (!token) return null
  try {
    const candidate = Buffer.from(token.split('.')[0], 'base64url').toString('utf8')
    return /^\d{17,20}$/.test(candidate) ? candidate : null
  } catch {
    return null
  }
}

export function productionDiscordContractProblems(environment = process.env) {
  const problems = []
  const clientId = trimmed(environment, 'DISCORD_CLIENT_ID')
  const guildId = trimmed(environment, 'DISCORD_GUILD_ID')
  const reviewChannelId = trimmed(environment, 'DISCORD_APPLICATIONS_CHANNEL_ID')
  const appUrl = trimmed(environment, 'APP_URL')
  const redirectUri = trimmed(environment, 'DISCORD_REDIRECT_URI')
  const adminIds = trimmed(environment, 'ADMIN_DISCORD_IDS')

  if (clientId && clientId !== NIGHTBUDDY_APPLICATION_ID) {
    problems.push(`DISCORD_CLIENT_ID must be the NIGHTBUDDY application (${NIGHTBUDDY_APPLICATION_ID})`)
  }
  if (guildId && guildId !== NIGHTRAID_GUILD_ID) {
    problems.push(`DISCORD_GUILD_ID must be the NIGHTRAID BATTLEGROUND server (${NIGHTRAID_GUILD_ID})`)
  }
  if (reviewChannelId && reviewChannelId !== NIGHTRAID_REVIEW_CHANNEL_ID) {
    problems.push(`DISCORD_APPLICATIONS_CHANNEL_ID must be the NIGHTRAID application review channel (${NIGHTRAID_REVIEW_CHANNEL_ID})`)
  }
  if (appUrl && !isExactOrigin(appUrl, NIGHTRAID_APP_ORIGIN)) {
    problems.push(`APP_URL must be the production website origin (${NIGHTRAID_APP_ORIGIN})`)
  }
  if (redirectUri && !isExactUrl(redirectUri, NIGHTRAID_DISCORD_CALLBACK)) {
    problems.push(`DISCORD_REDIRECT_URI must be the production Discord callback (${NIGHTRAID_DISCORD_CALLBACK})`)
  }
  if (adminIds && !hasExactAdminIds(adminIds)) {
    problems.push('ADMIN_DISCORD_IDS must contain exactly the authorized NIGHTRAID administrator Discord IDs')
  }

  return problems
}

function requiredProductionContractProblems(environment, requiredNames) {
  const problems = requiredNames
    .filter((name) => !trimmed(environment, name))
    .map((name) => `${name} is missing`)
  problems.push(...productionDiscordContractProblems(environment))
  return problems
}

export function applicationReviewContractProblems(environment = process.env) {
  return requiredProductionContractProblems(environment, [
    'DISCORD_APPLICATIONS_CHANNEL_ID',
    'APP_URL',
    'ADMIN_DISCORD_IDS',
  ])
}

export function renderDiscordContractProblems(environment = process.env) {
  return requiredProductionContractProblems(environment, [
    'DISCORD_CLIENT_ID',
    'DISCORD_GUILD_ID',
    'DISCORD_APPLICATIONS_CHANNEL_ID',
    'APP_URL',
    'ADMIN_DISCORD_IDS',
  ])
}

export function nightbuddyRuntimeIdentityProblem(client) {
  if (client?.user?.id !== NIGHTBUDDY_APPLICATION_ID) {
    return `Discord authenticated a bot other than NIGHTBUDDY (${NIGHTBUDDY_APPLICATION_ID})`
  }
  return null
}

export function discordHealthResponse(client, environment = process.env) {
  if (renderDiscordContractProblems(environment).length > 0) {
    return { status: 503, body: 'NIGHTBUDDY production configuration is incomplete.' }
  }
  if (typeof client?.isReady !== 'function' || !client.isReady()) {
    return { status: 503, body: 'NIGHTBUDDY is not ready.' }
  }
  const identityProblem = nightbuddyRuntimeIdentityProblem(client)
  if (identityProblem) return { status: 503, body: identityProblem }
  if (!client?.guilds?.cache?.has?.(NIGHTRAID_GUILD_ID)) {
    return { status: 503, body: 'NIGHTBUDDY is not connected to NIGHTRAID BATTLEGROUND.' }
  }
  return { status: 200, body: NIGHTBUDDY_READY_BODY }
}
