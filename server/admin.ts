import { env } from './env.js'

export function isAdminDiscordId(discordUserId: string) {
  return env.adminDiscordIds().has(discordUserId)
}
