// Routed through the consolidated Vercel API function.
import { z } from 'zod'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { allowAdminMutation, getAdminSession } from '../../../../server/admin-request.js'
import { DecisionConflictError, rejectApplication } from '../../../../server/application-decisions.js'
import { hasTrustedOrigin, methodNotAllowed, requestBody, singleQueryValue } from '../../../../server/http.js'

const rejectionSchema = z.object({ reason: z.string().trim().min(2).max(500) }).strict()

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'POST') return methodNotAllowed(response, ['POST'])
  if (!hasTrustedOrigin(request)) return response.status(403).json({ message: 'Untrusted request origin.' })
  const admin = await getAdminSession(request)
  if (!admin) return response.status(403).json({ message: 'Administrator access is required.' })
  if (!(await allowAdminMutation(request, response, admin.discordUserId))) return
  const id = singleQueryValue(request.query.id)
  if (!id) return response.status(400).json({ message: 'Application ID is required.' })
  const parsed = rejectionSchema.safeParse(requestBody(request))
  if (!parsed.success) return response.status(400).json({ message: 'A rejection reason is required.' })

  try {
    const result = await rejectApplication({
      applicationId: id,
      reason: parsed.data.reason,
      source: 'WEB',
      decidedBy: admin.discordUserId,
      request,
    })
    return response.status(200).json({
      ...result,
      message:
        result.applicantNotification === 'COMPLETED'
          ? 'Application rejected and the applicant was notified through Discord.'
          : result.applicantNotification === 'PORTAL_ONLY'
            ? 'Application rejected. The applicant is not in the Discord server, so the decision is available in the status portal.'
            : 'Application rejected. The decision is visible in the status portal, but the Discord DM failed unexpectedly.',
    })
  } catch (reason) {
    if (reason instanceof DecisionConflictError) return response.status(409).json({ message: reason.message })
    console.error('Application rejection failed:', reason instanceof Error ? reason.message : 'Unknown error')
    return response.status(503).json({ message: 'Unable to reject the application.' })
  }
}

export const config = { maxDuration: 60 }
