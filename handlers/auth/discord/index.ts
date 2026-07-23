// Routed through the consolidated Vercel API function.
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { discordAuthorizeUrl } from '../../../server/discord.js'
import { methodNotAllowed, safeReturnTo, singleQueryValue } from '../../../server/http.js'
import { createOAuthState, setOAuthCookies } from '../../../server/session.js'

export default function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'GET') return methodNotAllowed(response, ['GET'])

  const state = createOAuthState()
  const returnTo = safeReturnTo(singleQueryValue(request.query.returnTo))
  setOAuthCookies(response, state, returnTo)
  return response.redirect(302, discordAuthorizeUrl(state))
}
