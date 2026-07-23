import type { ClanBanRow } from './database.types.js'
import { getSupabaseAdmin } from './supabase.js'

export function normalizeInGameName(value: string) {
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}

export function normalizeFacebookProfileUrl(value: string) {
  return value.trim().replace(/\/+$/, '').toLowerCase()
}

async function activeBanBy(column: 'discord_user_id' | 'in_game_name_normalized' | 'facebook_profile_url_normalized', value: string) {
  const { data, error } = await getSupabaseAdmin()
    .from('clan_bans')
    .select('*')
    .eq('is_active', true)
    .eq(column, value)
    .limit(1)
    .maybeSingle()

  if (error) throw new Error(`Ban check failed: ${error.message}`)
  return data
}

export async function findActiveBan(input: {
  discordUserId?: string | null
  inGameName?: string | null
  facebookProfileUrl?: string | null
}): Promise<ClanBanRow | null> {
  const checks: Array<Promise<ClanBanRow | null>> = []
  if (input.discordUserId) checks.push(activeBanBy('discord_user_id', input.discordUserId.trim()))
  if (input.inGameName) checks.push(activeBanBy('in_game_name_normalized', normalizeInGameName(input.inGameName)))
  if (input.facebookProfileUrl) {
    checks.push(activeBanBy('facebook_profile_url_normalized', normalizeFacebookProfileUrl(input.facebookProfileUrl)))
  }
  if (checks.length === 0) return null
  const results = await Promise.all(checks)
  return results.find(Boolean) ?? null
}
