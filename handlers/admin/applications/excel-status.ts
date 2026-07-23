// Routed through the consolidated Vercel API function.
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getAdminSession } from '../../../server/admin-request.js'
import { EXCEL_BUCKET, MASTER_WORKBOOK_PATH } from '../../../server/excel-sync.js'
import { methodNotAllowed, noStore } from '../../../server/http.js'
import { getSupabaseAdmin } from '../../../server/supabase.js'

const statuses = ['NOT_STARTED', 'PENDING', 'SYNCED', 'FAILED'] as const

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'GET') return methodNotAllowed(response, ['GET'])
  noStore(response)
  const admin = await getAdminSession(request)
  if (!admin) return response.status(403).json({ message: 'Administrator access is required.' })
  const supabase = getSupabaseAdmin()

  const [countResults, latestResult] = await Promise.all([
    Promise.all(statuses.map(async (status) => {
      const { count, error } = await supabase
        .from('clan_applications')
        .select('id', { count: 'exact', head: true })
        .eq('excel_sync_status', status)
      if (error) throw new Error(error.message)
      return [status, count ?? 0] as const
    })),
    supabase
      .from('excel_exports')
      .select('*')
      .eq('export_type', 'MASTER_SYNC')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]).catch((reason: unknown) => {
    console.error('Excel status query failed:', reason instanceof Error ? reason.message : 'Unknown error')
    return [null, null] as const
  })

  if (!countResults || !latestResult || latestResult.error) {
    return response.status(503).json({ message: 'Excel synchronization status is unavailable. Run the Phase 6 SQL setup first.' })
  }

  let downloadUrl: string | null = null
  if (latestResult.data?.status === 'COMPLETED') {
    const { data } = await supabase.storage.from(EXCEL_BUCKET).createSignedUrl(MASTER_WORKBOOK_PATH, 600, {
      download: 'NightRaid_Applicants.xlsx',
    })
    downloadUrl = data?.signedUrl ?? null
  }

  return response.status(200).json({
    counts: Object.fromEntries(countResults),
    latestSync: latestResult.data,
    downloadUrl,
  })
}
