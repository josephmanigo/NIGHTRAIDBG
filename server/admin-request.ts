import type { VercelRequest, VercelResponse } from '@vercel/node'
import { isAdminDiscordId } from './admin.js'
import { consumeRateLimit, rateLimitResponse } from './rate-limit.js'
import { getSession } from './session.js'

export async function getAdminSession(request: VercelRequest) {
  const session = await getSession(request)
  if (!session || !isAdminDiscordId(session.discordUserId)) return null
  return session
}

export async function allowAdminMutation(
  request: VercelRequest,
  response: VercelResponse,
  discordUserId: string,
) {
  const result = await consumeRateLimit({
    scope: 'admin-mutation',
    subject: discordUserId,
    request,
    limit: 30,
    windowSeconds: 5 * 60,
    blockSeconds: 10 * 60,
  })
  if (result.allowed) return true
  rateLimitResponse(response, result)
  return false
}
