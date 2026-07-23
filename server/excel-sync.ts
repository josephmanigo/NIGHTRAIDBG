import type { Json } from './database.types.js'
import type { ExcelExportFilters } from './excel-data.js'
import { filtersForAudit, loadExcelRecords } from './excel-data.js'
import { buildNightRaidWorkbook, EXCEL_MIME } from './excel-workbook.js'
import { getSupabaseAdmin } from './supabase.js'

export const EXCEL_BUCKET = 'nightraid-excel'
export const MASTER_WORKBOOK_PATH = 'NightRaid_Applicants.xlsx'

export type ExcelExportType = 'MASTER_SYNC' | 'MANUAL_ALL' | 'MANUAL_FILTERED' | 'MANUAL_SELECTED'

function safeError(reason: unknown) {
  return (reason instanceof Error ? reason.message : 'Excel operation failed.').slice(0, 500)
}

async function updateSyncStatus(applicationIds: string[], values: {
  excel_sync_status: 'PENDING' | 'SYNCED' | 'FAILED'
  excel_synced_at?: string | null
  excel_sync_error?: string | null
}) {
  const supabase = getSupabaseAdmin()
  for (let index = 0; index < applicationIds.length; index += 200) {
    const ids = applicationIds.slice(index, index + 200)
    if (ids.length === 0) continue
    const { error } = await supabase.from('clan_applications').update(values).in('id', ids)
    if (error) throw new Error(`Excel synchronization status could not be updated: ${error.message}`)
  }
}

export async function recordExcelExport(input: {
  exportType: ExcelExportType
  filters: ExcelExportFilters
  recordCount: number
  generatedBy: string
  storagePath?: string | null
  status: 'COMPLETED' | 'FAILED'
  errorMessage?: string | null
}) {
  const { error } = await getSupabaseAdmin().from('excel_exports').insert({
    export_type: input.exportType,
    filters: filtersForAudit(input.filters) as Json,
    record_count: input.recordCount,
    generated_by: input.generatedBy,
    storage_path: input.storagePath ?? null,
    status: input.status,
    error_message: input.errorMessage ?? null,
  })
  if (error) console.error('Excel export audit record failed:', error.message)
}

export async function createExcelExport(filters: ExcelExportFilters, generatedBy: string) {
  const records = await loadExcelRecords(filters)
  const buffer = await buildNightRaidWorkbook(records, { generatedBy, filters })
  return { records, buffer }
}

export async function syncExcelRegister(triggerApplicationIds?: string[], generatedBy = 'SYSTEM') {
  let trackedIds = triggerApplicationIds ?? []
  let recordCount = 0
  try {
    if (trackedIds.length > 0) {
      await updateSyncStatus(trackedIds, {
        excel_sync_status: 'PENDING',
        excel_synced_at: null,
        excel_sync_error: null,
      })
    }

    const records = await loadExcelRecords({})
    recordCount = records.length
    const allApplicationIds = records.map(({ application }) => application.id)
    if (trackedIds.length === 0) trackedIds = allApplicationIds
    if (triggerApplicationIds === undefined && allApplicationIds.length > 0) {
      await updateSyncStatus(allApplicationIds, {
        excel_sync_status: 'PENDING',
        excel_synced_at: null,
        excel_sync_error: null,
      })
    }

    const buffer = await buildNightRaidWorkbook(records, { generatedBy, filters: {} })
    const { error: uploadError } = await getSupabaseAdmin().storage
      .from(EXCEL_BUCKET)
      .upload(MASTER_WORKBOOK_PATH, buffer, { contentType: EXCEL_MIME, upsert: true, cacheControl: '0' })
    if (uploadError) throw new Error(`The private Excel workbook could not be stored: ${uploadError.message}`)

    const syncedAt = new Date().toISOString()
    await updateSyncStatus(allApplicationIds, {
      excel_sync_status: 'SYNCED',
      excel_synced_at: syncedAt,
      excel_sync_error: null,
    })
    await recordExcelExport({
      exportType: 'MASTER_SYNC', filters: {}, recordCount, generatedBy,
      storagePath: MASTER_WORKBOOK_PATH, status: 'COMPLETED',
    })
    return { status: 'SYNCED' as const, recordCount, syncedAt }
  } catch (reason) {
    const error = safeError(reason)
    try {
      await updateSyncStatus(trackedIds, {
        excel_sync_status: 'FAILED',
        excel_synced_at: null,
        excel_sync_error: error,
      })
    } catch (statusReason) {
      console.error('Excel failure status could not be saved:', safeError(statusReason))
    }
    await recordExcelExport({
      exportType: 'MASTER_SYNC', filters: {}, recordCount, generatedBy,
      storagePath: MASTER_WORKBOOK_PATH, status: 'FAILED', errorMessage: error,
    })
    console.error('Excel synchronization failed:', error)
    return { status: 'FAILED' as const, recordCount, error }
  }
}
