import type { VercelRequest, VercelResponse } from '@vercel/node'
import { discordAvatarUrl, discordDisplayName, exchangeDiscordCode, fetchDiscordUser } from '../../../server/discord.js'
import { encryptSecret } from '../../../server/encryption.js'
import { appUrl, methodNotAllowed, safeReturnTo, singleQueryValue } from '../../../server/http.js'
import {
  clearOAuthCookies,
  createSessionToken,
  matchesOAuthState,
  readOAuthState,
  readReturnTo,
  setSessionCookie,
} from '../../../server/session.js'
import { getSupabaseAdmin } from '../../../server/supabase.js'

function oauthFailure(request: VercelRequest, response: VercelResponse, reason: string) {
  clearOAuthCookies(response)
  return response.redirect(302, appUrl(request, `/?discord_error=${encodeURIComponent(reason)}#apply`))
}

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'GET') return methodNotAllowed(response, ['GET'])

  const code = singleQueryValue(request.query.code)
  const state = singleQueryValue(request.query.state)
  const expectedState = readOAuthState(request)
  if (!code || !matchesOAuthState(expectedState, state)) return oauthFailure(request, response, 'invalid_oauth_state')

  try {
    const token = await exchangeDiscordCode(code)
    const discordUser = await fetchDiscordUser(token.access_token)
    const discordUsername = discordDisplayName(discordUser)
    const discordAvatar = discordAvatarUrl(discordUser)
    const expiresAt = new Date(Date.now() + token.expires_in * 1000).toISOString()

    const { error } = await getSupabaseAdmin()
      .from('discord_connections')
      .upsert(
        {
          discord_user_id: discordUser.id,
          discord_username: discordUsername,
          discord_avatar: discordAvatar,
          encrypted_access_token: encryptSecret(token.access_token),
          encrypted_refresh_token: token.refresh_token ? encryptSecret(token.refresh_token) : null,
          token_expires_at: expiresAt,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'discord_user_id' },
      )

    if (error) throw new Error(`Unable to save the Discord connection: ${error.message}`)

    const sessionToken = await createSessionToken({
      discordUserId: discordUser.id,
      discordUsername,
      discordAvatar,
    })
    setSessionCookie(response, sessionToken)
    const returnTo = safeReturnTo(readReturnTo(request))
    clearOAuthCookies(response)
    return response.redirect(302, appUrl(request, returnTo))
  } catch (error) {
    console.error('Discord OAuth callback failed:', error instanceof Error ? error.message : 'Unknown error')
    return oauthFailure(request, response, 'discord_connection_failed')
  }
}
