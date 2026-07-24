// Routed through the consolidated Vercel API function.
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { allowAdminMutation, getAdminSession } from '../../../../server/admin-request.js'
import { approveApplication, DecisionConflictError } from '../../../../server/application-decisions.js'
import { hasTrustedOrigin, methodNotAllowed, singleQueryValue } from '../../../../server/http.js'

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'POST') return methodNotAllowed(response, ['POST'])
  if (!hasTrustedOrigin(request)) return response.status(403).json({ message: 'Untrusted request origin.' })
  const admin = await getAdminSession(request)
  if (!admin) return response.status(403).json({ message: 'Administrator access is required.' })
  if (!(await allowAdminMutation(request, response, admin.discordUserId))) return
  const id = singleQueryValue(request.query.id)
  if (!id) return response.status(400).json({ message: 'Application ID is required.' })

  try {
    const result = await approveApplication({
      applicationId: id,
      source: 'WEB',
      decidedBy: admin.discordUserId,
      request,
    })
    const { application, onboarding, googleSheetsSync } = result
    const notificationNote =
      result.applicantNotification === 'COMPLETED'
        ? ' The applicant was notified through Discord.'
        : result.applicantNotification === 'PORTAL_ONLY'
          ? ' The applicant is not in the Discord server, so the acceptance is visible in the applicant portal.'
          : ' The Discord DM failed unexpectedly, but the acceptance is visible in the applicant portal.'
    const sheetNote =
      googleSheetsSync.status === 'SYNCED'
        ? ' The accepted-applicant Google Sheet was updated.'
        : ' Google Sheets synchronization needs configuration or attention.'
    return response.status(200).json({
      application: { ...application, status: onboarding.status },
      onboarding,
      googleSheetsSync,
      applicantNotification: result.applicantNotification,
      ...('notificationError' in result ? { notificationError: result.notificationError } : {}),
      message:
        onboarding.status === 'COMPLETED'
          ? `Application approved and Discord onboarding completed.${notificationNote}${sheetNote}`
          : `Application approved, but Discord onboarding needs an administrator retry.${notificationNote}${sheetNote}`,
    })
  } catch (reason) {
    if (reason instanceof DecisionConflictError) return response.status(409).json({ message: reason.message })
    console.error('Approved application onboarding could not start:', reason instanceof Error ? reason.message : 'Unknown error')
    return response.status(503).json({
      message: 'The application was approved, but Discord onboarding could not start. Use Retry Discord.',
    })
  }
}

export const config = { maxDuration: 60 }
