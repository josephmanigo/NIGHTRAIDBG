import { env } from './env.js'

export interface DiscordTokenResponse {
  access_token: string
  token_type: string
  expires_in: number
  refresh_token?: string
  scope: string
}

export interface DiscordGuildMember {
  user?: DiscordUser
  roles: string[]
  joined_at?: string
}

export interface DiscordRole {
  id: string
  name: string
  managed: boolean
  position: number
}

interface DiscordChannel {
  id: string
}

const DISCORD_API = 'https://discord.com/api/v10'
export const MESSENGER_GROUP_CHAT_URL = 'https://m.me/ch/AbaeMdWdMHYbxpIE/'
export const DISCORD_NICKNAME_SERVER_URL = 'https://discord.gg/Ay8uSSJS3N'

const MESSENGER_GAME_TAGS: Record<string, string> = {
  Bloodstrike: 'BS',
  'Mobile Legends': 'ML',
  Farlight: 'FL',
}

export function acceptedApplicantDiscordMessage(input: {
  applicationNumber: string
  inGameName: string
  games: string[]
  onboardingComplete: boolean
}) {
  const safeInGameName = input.inGameName.replace(/[\r\n`]/g, ' ').replace(/\s+/g, ' ').trim()
  const headingName = safeInGameName.replace(/([\\*_~|>])/g, '\\$1')
  const messengerNicknames = input.games
    .map((game) => MESSENGER_GAME_TAGS[game])
    .filter(Boolean)
    .map((tag) => `${safeInGameName} (${tag})`)
  const messengerDisplay = messengerNicknames.length > 0
    ? messengerNicknames.join('  /  ')
    : `${safeInGameName} + division tag from an administrator`
  const progress = input.onboardingComplete
    ? 'Your Discord onboarding is complete. Your Trial Member and selected game roles are ready.'
    : 'Your entry has been approved. Discord onboarding is now being completed.'

  return [
    '# NIGHTRAID // ACCESS GRANTED',
    `> **APPLICATION ${input.applicationNumber}**`,
    `> ${progress}`,
    '',
    `## WELCOME TO THE RAID, ${headingName.toUpperCase()}`,
    'Complete the identity setup below before entering active operations.',
    '',
    '### MESSENGER GROUP CHAT',
    `**Nickname:** \`${messengerDisplay}\``,
    `**Enter:** [JOIN THE NIGHTRAID GROUP](${MESSENGER_GROUP_CHAT_URL})`,
    '',
    '### DISCORD SERVER',
    `**Nickname:** \`NIGHT \u2022 ${safeInGameName}\``,
    `**Change it here:** [OPEN THE NICKNAME CHANNEL](${DISCORD_NICKNAME_SERVER_URL})`,
    '',
    '### NEXT ORDERS',
    '1. Join the Messenger group chat.',
    '2. Change both nicknames to the formats above.',
    '3. Review the clan rules and complete your trial period.',
    '',
    '**BUILT IN DARKNESS. PROVEN UNDER PRESSURE.**',
  ].join('\n')
}

export interface DiscordUser {
  id: string
  username: string
  global_name?: string | null
  avatar?: string | null
}

async function discordJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`Discord API request failed with status ${response.status}.`)
  return (await response.json()) as T
}

async function discordSuccess(response: Response, action: string) {
  if (!response.ok) throw new Error(`${action} failed with Discord status ${response.status}.`)
}

function botHeaders(json = false) {
  return {
    Authorization: `Bot ${env.discordBotToken()}`,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  }
}

export function discordAuthorizeUrl(state: string) {
  const url = new URL('https://discord.com/oauth2/authorize')
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', env.discordClientId())
  url.searchParams.set('redirect_uri', env.discordRedirectUri())
  url.searchParams.set('scope', 'identify guilds.join')
  url.searchParams.set('state', state)
  url.searchParams.set('prompt', 'consent')
  return url.toString()
}

export async function exchangeDiscordCode(code: string) {
  const body = new URLSearchParams({
    client_id: env.discordClientId(),
    client_secret: env.discordClientSecret(),
    grant_type: 'authorization_code',
    code,
    redirect_uri: env.discordRedirectUri(),
  })
  const response = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  return discordJson<DiscordTokenResponse>(response)
}

export async function refreshDiscordToken(refreshToken: string) {
  const body = new URLSearchParams({
    client_id: env.discordClientId(),
    client_secret: env.discordClientSecret(),
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  })
  const response = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  return discordJson<DiscordTokenResponse>(response)
}

export async function fetchDiscordUser(accessToken: string) {
  const response = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  return discordJson<DiscordUser>(response)
}

export async function fetchDiscordGuildMember(discordUserId: string) {
  const response = await fetch(
    `${DISCORD_API}/guilds/${encodeURIComponent(env.discordGuildId())}/members/${encodeURIComponent(discordUserId)}`,
    { headers: botHeaders() },
  )
  if (response.status === 404) return null
  return discordJson<DiscordGuildMember>(response)
}

export async function fetchDiscordGuildRoles() {
  const response = await fetch(`${DISCORD_API}/guilds/${encodeURIComponent(env.discordGuildId())}/roles`, {
    headers: botHeaders(),
  })
  return discordJson<DiscordRole[]>(response)
}

export async function addDiscordGuildMember(discordUserId: string, accessToken: string, roleIds: string[]) {
  const response = await fetch(
    `${DISCORD_API}/guilds/${encodeURIComponent(env.discordGuildId())}/members/${encodeURIComponent(discordUserId)}`,
    {
      method: 'PUT',
      headers: botHeaders(true),
      body: JSON.stringify({ access_token: accessToken, roles: roleIds }),
    },
  )
  await discordSuccess(response, 'Adding the applicant to the NightRaid server')
  return response.status === 201
}

export async function addDiscordMemberRole(discordUserId: string, roleId: string) {
  const response = await fetch(
    `${DISCORD_API}/guilds/${encodeURIComponent(env.discordGuildId())}/members/${encodeURIComponent(discordUserId)}/roles/${encodeURIComponent(roleId)}`,
    { method: 'PUT', headers: botHeaders() },
  )
  await discordSuccess(response, 'Assigning a NightRaid role')
}

export async function sendDiscordDirectMessage(discordUserId: string, content: string) {
  const channelResponse = await fetch(`${DISCORD_API}/users/@me/channels`, {
    method: 'POST',
    headers: botHeaders(true),
    body: JSON.stringify({ recipient_id: discordUserId }),
  })
  const channel = await discordJson<DiscordChannel>(channelResponse)
  const messageResponse = await fetch(`${DISCORD_API}/channels/${encodeURIComponent(channel.id)}/messages`, {
    method: 'POST',
    headers: botHeaders(true),
    body: JSON.stringify({
      content,
      allowed_mentions: { parse: [] },
    }),
  })
  await discordSuccess(messageResponse, 'Sending the NightRaid direct message')
}

export async function sendDiscordAdminAlert(content: string) {
  const channelId = env.discordAdminChannelId()
  if (!channelId) return false
  const response = await fetch(`${DISCORD_API}/channels/${encodeURIComponent(channelId)}/messages`, {
    method: 'POST',
    headers: botHeaders(true),
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
  })
  await discordSuccess(response, 'Sending the NightRaid administrator alert')
  return true
}

export async function sendDiscordWelcomeMessage(
  discordUserId: string,
  applicationNumber: string,
  inGameName: string,
  games: string[],
) {
  return sendDiscordDirectMessage(
    discordUserId,
    acceptedApplicantDiscordMessage({
      applicationNumber,
      inGameName,
      games,
      onboardingComplete: true,
    }),
  )
}

export function discordDisplayName(user: DiscordUser) {
  return user.global_name?.trim() || user.username
}

export function discordAvatarUrl(user: DiscordUser) {
  if (!user.avatar) return null
  return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`
}
