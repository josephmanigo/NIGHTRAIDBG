// Routed through the consolidated Vercel API function.
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { hasTrustedOrigin, methodNotAllowed } from '../../server/http.js'
import { MembershipConflictError, leaveClan } from '../../server/membership-exit.js'
import { getSession } from '../../server/session.js'

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'POST') return methodNotAllowed(response, ['POST'])
  if (!hasTrustedOrigin(request)) return response.status(403).json({ message: 'Untrusted request origin.' })
  const session = await getSession(request)
  if (!session) return response.status(401).json({ message: 'Connect Discord before leaving the clan.' })

  try {
    const result = await leaveClan({ discordUserId: session.discordUserId, request })
    return response.status(200).json({
      ...result,
      message:
        result.discordCleanup === 'COMPLETED'
          ? 'You have left NightRaid. Your Discord game roles were cleared.'
          : 'You have left NightRaid, but the Discord role cleanup failed. An administrator can finish it manually.',
    })
  } catch (reason) {
    if (reason instanceof MembershipConflictError) {
      return response.status(409).json({ message: 'Your account is not an active NightRaid member.' })
    }
    console.error('Leaving the clan failed:', reason instanceof Error ? reason.message : 'Unknown error')
    return response.status(503).json({ message: 'Unable to leave the clan right now.' })
  }
}

export const config = { maxDuration: 60 }
