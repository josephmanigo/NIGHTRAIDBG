// Routed through the consolidated Vercel API function.
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { evaluateApplication } from '../../../../server/ai-evaluation.js'
import { allowAdminMutation, getAdminSession } from '../../../../server/admin-request.js'
import { recordAuditEvent } from '../../../../server/audit.js'
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
    const evaluation = await evaluateApplication(id)
    const excelSync = await syncExcelRegister([id], admin.discordUserId)
    await recordAuditEvent({
      actorType: 'ADMIN', actorId: admin.discordUserId, action: 'AI_EVALUATION_RETRIED',
      applicationId: id, outcome: evaluation.status === 'COMPLETED' ? 'SUCCESS' : 'FAILED', request,
    })
    if (evaluation.status === 'FAILED') {
      return response.status(503).json({
        message: 'AI review failed safely. The application remains queued for a human decision.',
        evaluationStatus: evaluation.status,
        excelSyncStatus: excelSync.status,
      })
    }
    return response.status(200).json({
      message: 'AI recommendation refreshed. An administrator still makes the final decision.',
      evaluationStatus: evaluation.status,
      excelSyncStatus: excelSync.status,
    })
  } catch (reason) {
    console.error('AI evaluation retry could not start:', reason instanceof Error ? reason.message : 'Unknown error')
    return response.status(409).json({ message: 'This application is not currently available for AI review.' })
  }
}

export const config = { maxDuration: 60 }
