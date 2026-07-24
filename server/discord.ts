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
  nick?: string | null
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
export const NIGHTRAID_CLAN_TAG = '\u119E\u6697NR'

const NIGHTRAID_CLANS = [
  { name: 'NIGHTRAID BG', id: '221853' },
  { name: 'NIGHTRAIDBS', id: '1040862' },
  { name: 'NIGHTRAID', id: '188859' },
] as const

const MESSENGER_GAME_TAGS: Record<string, string> = {
  Bloodstrike: 'BS',
  'Mobile Legends': 'ML',
  Farlight: 'FL',
}

export const NIGHT_NICKNAME_PREFIX = 'NIGHT • '
const DISCORD_NICKNAME_MAX_LENGTH = 32 // Discord's hard limit.

export function nightNickname(inGameName: string) {
  const safe = inGameName.replace(/[\r\n`]/g, ' ').replace(/\s+/g, ' ').trim()
  return `${NIGHT_NICKNAME_PREFIX}${safe}`.slice(0, DISCORD_NICKNAME_MAX_LENGTH).trim()
}

/* `NIGHT • Yepo` → `Yepo`; a nickname without the clan prefix comes back
 * unchanged. Tolerates the separator variants members type by hand. */
export function withoutNightPrefix(nickname: string) {
  return nickname.replace(/^night\s*[•·|:-]*\s*/i, '').trim()
}

export function acceptedApplicantDiscordMessage(input: {
  applicationNumber: string
  inGameName: string
  games: string[]
  onboardingComplete: boolean
  nicknameApplied?: boolean
}) {
  const safeInGameName = input.inGameName.replace(/[\r\n`]/g, ' ').replace(/\s+/g, ' ').trim()
  const headingName = safeInGameName.replace(/([\\*_~|>])/g, '\\$1')
  const messengerTags = input.games.map((game) => MESSENGER_GAME_TAGS[game]).filter(Boolean)
  const messengerDisplay = messengerTags.length > 0
    ? `${safeInGameName} (${messengerTags.join(', ')})`
    : `${safeInGameName} + division tag from an administrator`
  const progress = input.onboardingComplete
    ? 'Your Discord onboarding is complete. Your selected game roles are ready.'
    : 'Your entry has been approved. Discord onboarding is now being completed.'

  return [
    '# NIGHTRAID // ACCESS GRANTED',
    `> **APPLICATION ${input.applicationNumber}**`,
    `> ${progress}`,
    '',
    `## WELCOME TO NIGHTRAID, ${headingName.toUpperCase()}`,
    'Complete the identity setup below before entering active operations.',
    '',
    '### MESSENGER GROUP CHAT',
    `**Nickname:** \`${messengerDisplay}\``,
    `**Enter:** [JOIN THE NIGHTRAID GROUP](${MESSENGER_GROUP_CHAT_URL})`,
    '',
    '### DISCORD SERVER',
    ...(input.nicknameApplied
      ? [`**Nickname:** \`${nightNickname(input.inGameName)}\` \u2014 already set for you.`]
      : [
          `**Nickname:** \`NIGHT \u2022 ${safeInGameName}\``,
          `**Change it here:** [OPEN THE NICKNAME CHANNEL](${DISCORD_NICKNAME_SERVER_URL})`,
        ]),
    '',
    '### IN-GAME IDENTITY',
    `**Clan tag:** \`${NIGHTRAID_CLAN_TAG}\``,
    `**Your IGN:** \`${safeInGameName}${NIGHTRAID_CLAN_TAG}\``,
    `**Sample IGN:** \`Yepo${NIGHTRAID_CLAN_TAG}\``,
    '',
    '### CLAN IDS',
    ...NIGHTRAID_CLANS.map((clan, index) => `${index + 1}. **${clan.name}** \u2014 Clan ID: \`${clan.id}\``),
    '',
    '### NEXT ORDERS',
    '1. Join the Messenger group chat.',
    input.nicknameApplied
      ? '2. Set your Messenger nickname to the format above — your Discord nickname is already done.'
      : '2. Change both nicknames to the formats above.',
    '3. Update your in-game name with the NIGHTRAID clan tag.',
    '4. Join the assigned in-game clan using the clan IDs above.',
    '5. Review the clan rules and complete your trial period.',
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
  await discordSuccess(response, 'Adding the applicant to the NIGHTRAID server')
  return response.status === 201
}

export async function addDiscordMemberRole(discordUserId: string, roleId: string) {
  const response = await fetch(
    `${DISCORD_API}/guilds/${encodeURIComponent(env.discordGuildId())}/members/${encodeURIComponent(discordUserId)}/roles/${encodeURIComponent(roleId)}`,
    { method: 'PUT', headers: botHeaders() },
  )
  await discordSuccess(response, 'Assigning a NIGHTRAID role')
}

export async function removeDiscordMemberRole(discordUserId: string, roleId: string) {
  const response = await fetch(
    `${DISCORD_API}/guilds/${encodeURIComponent(env.discordGuildId())}/members/${encodeURIComponent(discordUserId)}/roles/${encodeURIComponent(roleId)}`,
    { method: 'DELETE', headers: botHeaders() },
  )
  if (response.status === 404) return
  await discordSuccess(response, 'Removing a NIGHTRAID role')
}

/* Sets (or clears, with null) a member's server nickname. Returns false when
 * Discord refuses the rename — the server owner, a member with a role above
 * the bot's, or someone no longer in the server — so callers can treat an
 * unmanageable member as a soft failure instead of aborting their flow. */
export async function setDiscordMemberNickname(discordUserId: string, nickname: string | null) {
  const response = await fetch(
    `${DISCORD_API}/guilds/${encodeURIComponent(env.discordGuildId())}/members/${encodeURIComponent(discordUserId)}`,
    { method: 'PATCH', headers: botHeaders(true), body: JSON.stringify({ nick: nickname }) },
  )
  if (response.status === 403 || response.status === 404) return false
  await discordSuccess(response, 'Updating the NIGHTRAID member nickname')
  return true
}

export async function removeDiscordGuildMember(discordUserId: string) {
  const response = await fetch(
    `${DISCORD_API}/guilds/${encodeURIComponent(env.discordGuildId())}/members/${encodeURIComponent(discordUserId)}`,
    { method: 'DELETE', headers: botHeaders() },
  )
  if (response.status === 404) return
  await discordSuccess(response, 'Removing the member from the NIGHTRAID server')
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
  await discordSuccess(messageResponse, 'Sending the NIGHTRAID direct message')
}

export async function sendDiscordAdminAlert(content: string) {
  const channelId = env.discordAdminChannelId()
  if (!channelId) return false
  const response = await fetch(`${DISCORD_API}/channels/${encodeURIComponent(channelId)}/messages`, {
    method: 'POST',
    headers: botHeaders(true),
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
  })
  await discordSuccess(response, 'Sending the NIGHTRAID administrator alert')
  return true
}

export async function sendDiscordWelcomeMessage(
  discordUserId: string,
  applicationNumber: string,
  inGameName: string,
  games: string[],
  nicknameApplied: boolean,
) {
  return sendDiscordDirectMessage(
    discordUserId,
    acceptedApplicantDiscordMessage({
      applicationNumber,
      inGameName,
      games,
      onboardingComplete: true,
      nicknameApplied,
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
