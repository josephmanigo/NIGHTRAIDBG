import type { VercelRequest, VercelResponse } from '@vercel/node'
import { isAdminDiscordId } from '../../server/admin.js'
import { methodNotAllowed, noStore } from '../../server/http.js'
import { getSession } from '../../server/session.js'

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'GET') return methodNotAllowed(response, ['GET'])
  noStore(response)
  const session = await getSession(request)
  if (!session) return response.status(200).json({ connected: false, isAdmin: false })

  return response.status(200).json({
    connected: true,
    discordUsername: session.discordUsername,
    discordAvatar: session.discordAvatar,
    isAdmin: isAdminDiscordId(session.discordUserId),
  })
}
