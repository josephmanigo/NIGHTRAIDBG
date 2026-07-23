// Routed through the consolidated Vercel API function.
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getAdminSession } from '../../server/admin-request.js'
import { methodNotAllowed, noStore } from '../../server/http.js'
import { getSupabaseAdmin } from '../../server/supabase.js'

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'GET') return methodNotAllowed(response, ['GET'])
  noStore(response)
  const admin = await getAdminSession(request)
  if (!admin) return response.status(403).json({ message: 'Administrator access is required.' })

  const supabase = getSupabaseAdmin()
  const [banResult, auditResult] = await Promise.all([
    supabase.from('clan_bans').select('*').order('created_at', { ascending: false }).limit(100),
    supabase
      .from('security_audit_logs')
      .select('id,actor_type,actor_id,action,application_id,target_type,target_id,outcome,details,created_at')
      .order('created_at', { ascending: false })
      .limit(100),
  ])

  if (banResult.error || auditResult.error) {
    console.error('Admin security data failed:', banResult.error?.message || auditResult.error?.message)
    return response.status(503).json({ message: 'Unable to load security records.' })
  }

  return response.status(200).json({ bans: banResult.data ?? [], auditLogs: auditResult.data ?? [] })
}
