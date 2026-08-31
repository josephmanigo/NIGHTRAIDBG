import type { DiscordRole } from './discord.js'

export type DiscordGameRoleIds = Partial<Record<string, string | undefined>>

const GAME_ROLE_ENV_NAMES: Record<string, string> = {
  Bloodstrike: 'DISCORD_ROLE_BLOODSTRIKE_ID',
  'Mobile Legends': 'DISCORD_ROLE_MOBILE_LEGENDS_ID',
  'Honor of Kings': 'DISCORD_ROLE_HONOR_OF_KINGS_ID',
  Farlight: 'DISCORD_ROLE_FARLIGHT_ID',
  Crossfire: 'DISCORD_ROLE_CROSSFIRE_ID',
  Roblox: 'DISCORD_ROLE_ROBLOX_ID',
  'Dota 2': 'DISCORD_ROLE_DOTA_2_ID',
  Valorant: 'DISCORD_ROLE_VALORANT_ID',
}

/* Application values are intentionally stable while Discord role labels are
 * allowed to use the official game title or a short community label. Only
 * explicit aliases match; there is no fuzzy/substring role assignment. */
const GAME_ROLE_ALIASES: Record<string, string[]> = {
  Bloodstrike: ['Bloodstrike', 'Blood Strike'],
  'Mobile Legends': [
    'Mobile Legends',
    'Mobile Legends: Bang Bang',
    'Mobile Legends Bang Bang',
    'MLBB',
    'ML',
  ],
  'Honor of Kings': ['Honor of Kings', 'HOK'],
  Farlight: ['Farlight', 'Farlight 84'],
  Crossfire: ['Crossfire', 'Cross Fire'],
  Roblox: ['Roblox'],
  'Dota 2': ['Dota 2', 'DOTA2'],
  Valorant: ['Valorant'],
}

function normalizedRoleName(value: string) {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function roleEnvironmentName(game: string) {
  return GAME_ROLE_ENV_NAMES[game] || `DISCORD_ROLE_${game.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_ID`
}

export function resolveDiscordGameRoles(
  games: string[],
  guildRoles: DiscordRole[],
  configuredGameRoles: DiscordGameRoleIds,
) {
  const resolved = games.map((game) => {
    const environmentName = roleEnvironmentName(game)
    const configuredId = configuredGameRoles[game]
    let role: DiscordRole | undefined

    if (configuredId) {
      role = guildRoles.find((candidate) => candidate.id === configuredId)
      if (!role) {
        throw new Error(`The Discord role configured by ${environmentName} was not found in this server.`)
      }
    } else {
      const aliases = new Set((GAME_ROLE_ALIASES[game] || [game]).map(normalizedRoleName))
      const matches = guildRoles.filter((candidate) => aliases.has(normalizedRoleName(candidate.name)))
      if (matches.length > 1) {
        throw new Error(
          `The game "${game}" matched multiple Discord roles. Set ${environmentName} to the one role ID that should be assigned.`,
        )
      }
      role = matches[0]
      if (!role) {
        throw new Error(
          `No supported Discord role was found for "${game}". Create the role or set ${environmentName} to its role ID.`,
        )
      }
    }

    if (role.managed) throw new Error(`The Discord role "${role.name}" is managed and cannot be assigned.`)
    return role
  })

  return [...new Map(resolved.map((role) => [role.id, role])).values()]
}
