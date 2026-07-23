import type { VercelRequest, VercelResponse } from '@vercel/node'
import { allowAdminMutation, getAdminSession } from '../../../server/admin-request.js'
import { recordAuditEvent } from '../../../server/audit.js'
import { excelExportFiltersSchema, hasExportFilters } from '../../../server/excel-data.js'
import { EXCEL_MIME } from '../../../server/excel-workbook.js'
import { createExcelExport, recordExcelExport } from '../../../server/excel-sync.js'
import { hasTrustedOrigin, methodNotAllowed, noStore, requestBody } from '../../../server/http.js'

function filename(selected: boolean) {
  const prefix = selected ? 'NightRaid_Selected_Applicants' : 'NightRaid_Applicants'
  return `${prefix}_${new Date().toISOString().slice(0, 10)}.xlsx`
}

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'POST') return methodNotAllowed(response, ['POST'])
  if (!hasTrustedOrigin(request)) return response.status(403).json({ message: 'Untrusted request origin.' })
  noStore(response)
  const admin = await getAdminSession(request)
  if (!admin) return response.status(403).json({ message: 'Administrator access is required.' })
  if (!(await allowAdminMutation(request, response, admin.discordUserId))) return
  const parsed = excelExportFiltersSchema.safeParse(requestBody(request))
  if (!parsed.success) return response.status(400).json({ message: 'One or more Excel export options are invalid.' })
  const selected = Boolean(parsed.data.applicationIds)
  const exportType = selected ? 'MANUAL_SELECTED' : hasExportFilters(parsed.data) ? 'MANUAL_FILTERED' : 'MANUAL_ALL'

  try {
    const { records, buffer } = await createExcelExport(parsed.data, admin.discordUserId)
    await recordExcelExport({
      exportType,
      filters: parsed.data,
      recordCount: records.length,
      generatedBy: admin.discordUserId,
      status: 'COMPLETED',
    })
    await recordAuditEvent({
      actorType: 'ADMIN', actorId: admin.discordUserId, action: 'APPLICATIONS_EXPORTED',
      targetType: 'excel_export', outcome: 'SUCCESS', details: { exportType, recordCount: records.length }, request,
    })
    response.setHeader('Content-Type', EXCEL_MIME)
    response.setHeader('Content-Disposition', `attachment; filename="${filename(selected)}"`)
    response.setHeader('X-Content-Type-Options', 'nosniff')
    return response.status(200).send(buffer)
  } catch (reason) {
    const message = reason instanceof Error ? reason.message.slice(0, 500) : 'Excel export failed.'
    await recordExcelExport({
      exportType,
      filters: parsed.data,
      recordCount: 0,
      generatedBy: admin.discordUserId,
      status: 'FAILED',
      errorMessage: message,
    })
    await recordAuditEvent({
      actorType: 'ADMIN', actorId: admin.discordUserId, action: 'APPLICATIONS_EXPORT_FAILED',
      targetType: 'excel_export', outcome: 'FAILED', details: { exportType }, request,
    })
    console.error('Selected Excel export failed:', message)
    return response.status(503).json({ message: 'The Excel workbook could not be generated.' })
  }
}

export const config = { maxDuration: 60 }
