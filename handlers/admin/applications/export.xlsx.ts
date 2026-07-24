// Routed through the consolidated Vercel API function.
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getAdminSession } from '../../../server/admin-request.js'
import { hasExportFilters, parseExcelQueryFilters } from '../../../server/excel-data.js'
import { EXCEL_MIME } from '../../../server/excel-workbook.js'
import { createExcelExport, recordExcelExport } from '../../../server/excel-sync.js'
import { methodNotAllowed, noStore } from '../../../server/http.js'

function filename() {
  return `NIGHTRAID_Applicants_${new Date().toISOString().slice(0, 10)}.xlsx`
}

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'GET') return methodNotAllowed(response, ['GET'])
  noStore(response)
  const admin = await getAdminSession(request)
  if (!admin) return response.status(403).json({ message: 'Administrator access is required.' })
  const parsed = parseExcelQueryFilters(request.query)
  if (!parsed.success) return response.status(400).json({ message: 'One or more Excel export filters are invalid.' })

  try {
    const { records, buffer } = await createExcelExport(parsed.data, admin.discordUserId)
    await recordExcelExport({
      exportType: hasExportFilters(parsed.data) ? 'MANUAL_FILTERED' : 'MANUAL_ALL',
      filters: parsed.data,
      recordCount: records.length,
      generatedBy: admin.discordUserId,
      status: 'COMPLETED',
    })
    response.setHeader('Content-Type', EXCEL_MIME)
    response.setHeader('Content-Disposition', `attachment; filename="${filename()}"`)
    response.setHeader('X-Content-Type-Options', 'nosniff')
    return response.status(200).send(buffer)
  } catch (reason) {
    const message = reason instanceof Error ? reason.message.slice(0, 500) : 'Excel export failed.'
    await recordExcelExport({
      exportType: hasExportFilters(parsed.data) ? 'MANUAL_FILTERED' : 'MANUAL_ALL',
      filters: parsed.data,
      recordCount: 0,
      generatedBy: admin.discordUserId,
      status: 'FAILED',
      errorMessage: message,
    })
    console.error('Excel download failed:', message)
    return response.status(503).json({ message: 'The Excel workbook could not be generated.' })
  }
}

export const config = { maxDuration: 60 }
