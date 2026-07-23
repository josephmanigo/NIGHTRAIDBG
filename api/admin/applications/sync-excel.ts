import { z } from 'zod'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { allowAdminMutation, getAdminSession } from '../../../server/admin-request.js'
import { recordAuditEvent } from '../../../server/audit.js'
import { syncExcelRegister } from '../../../server/excel-sync.js'
import { hasTrustedOrigin, methodNotAllowed, requestBody } from '../../../server/http.js'

const syncSchema = z.object({
  applicationIds: z.array(z.string().uuid()).min(1).max(500).optional(),
}).strict()

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'POST') return methodNotAllowed(response, ['POST'])
  if (!hasTrustedOrigin(request)) return response.status(403).json({ message: 'Untrusted request origin.' })
  const admin = await getAdminSession(request)
  if (!admin) return response.status(403).json({ message: 'Administrator access is required.' })
  if (!(await allowAdminMutation(request, response, admin.discordUserId))) return
  const parsed = syncSchema.safeParse(requestBody(request))
  if (!parsed.success) return response.status(400).json({ message: 'The Excel synchronization selection is invalid.' })

  const result = await syncExcelRegister(parsed.data.applicationIds, admin.discordUserId)
  await recordAuditEvent({
    actorType: 'ADMIN', actorId: admin.discordUserId, action: 'EXCEL_REGISTER_SYNCED',
    targetType: 'excel_register', outcome: result.status === 'SYNCED' ? 'SUCCESS' : 'FAILED',
    details: { recordCount: result.recordCount }, request,
  })
  if (result.status === 'FAILED') {
    return response.status(503).json({
      result,
      message: 'Excel synchronization failed safely. Applications remain stored in the database and can be retried.',
    })
  }
  return response.status(200).json({
    result,
    message: `Excel applicant register synchronized with ${result.recordCount} applications.`,
  })
}

export const config = { maxDuration: 60 }
