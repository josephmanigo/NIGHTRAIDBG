// Routed through the consolidated Vercel API function.
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { allowAdminMutation, getAdminSession } from '../../../../server/admin-request.js'
import { recordAuditEvent } from '../../../../server/audit.js'
import { getRequestOrigin, hasTrustedOrigin, methodNotAllowed, singleQueryValue } from '../../../../server/http.js'
import { notifyMessengerAdmins } from '../../../../server/messenger-notifications.js'

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'POST') return methodNotAllowed(response, ['POST'])
  if (!hasTrustedOrigin(request)) return response.status(403).json({ message: 'Untrusted request origin.' })
  const admin = await getAdminSession(request)
  if (!admin) return response.status(403).json({ message: 'Administrator access is required.' })
  if (!(await allowAdminMutation(request, response, admin.discordUserId))) return
  const id = singleQueryValue(request.query.id)
  if (!id) return response.status(400).json({ message: 'Application ID is required.' })

  try {
    const notification = await notifyMessengerAdmins(id, getRequestOrigin(request))
    await recordAuditEvent({
      actorType: 'ADMIN', actorId: admin.discordUserId, action: 'MESSENGER_NOTIFICATION_RETRIED',
      applicationId: id, outcome: notification.status === 'COMPLETED' ? 'SUCCESS' : 'FAILED', request,
    })
    if (notification.status === 'FAILED') {
      return response.status(503).json({
        message: 'Messenger delivery failed. The application remains available in the admin portal.',
        notification,
      })
    }
    return response.status(200).json({
      message: `Messenger notification delivered to ${notification.delivered} administrator${notification.delivered === 1 ? '' : 's'}.`,
      notification,
    })
  } catch (reason) {
    console.error('Messenger notification retry could not start:', reason instanceof Error ? reason.message : 'Unknown error')
    return response.status(409).json({ message: 'This application is not currently available for a Messenger retry.' })
  }
}

export const config = { maxDuration: 60 }
