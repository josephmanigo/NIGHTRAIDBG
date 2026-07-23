// Routed through the consolidated Vercel API function.
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { allowAdminMutation, getAdminSession } from '../../../../server/admin-request.js'
import { recordAuditEvent } from '../../../../server/audit.js'
import { onboardApprovedApplication } from '../../../../server/discord-onboarding.js'
import { syncExcelRegister } from '../../../../server/excel-sync.js'
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
    const onboarding = await onboardApprovedApplication(id)
    const excelSync = await syncExcelRegister([id], admin.discordUserId)
    await recordAuditEvent({
      actorType: 'ADMIN', actorId: admin.discordUserId, action: 'DISCORD_ONBOARDING_RETRIED',
      applicationId: id, outcome: onboarding.status === 'COMPLETED' ? 'SUCCESS' : 'FAILED', request,
    })
    return response.status(200).json({
      onboarding,
      excelSync,
      message:
        onboarding.status === 'COMPLETED'
          ? 'Discord onboarding completed.'
          : 'Discord onboarding failed again. Review the saved error before retrying.',
    })
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : 'Discord onboarding could not be retried.'
    return response.status(409).json({ message })
  }
}

export const config = { maxDuration: 60 }
