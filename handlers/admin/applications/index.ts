// Routed through the consolidated Vercel API function.
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getAdminSession } from '../../../server/admin-request.js'
import { methodNotAllowed, noStore } from '../../../server/http.js'
import { getSupabaseAdmin } from '../../../server/supabase.js'

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'GET') return methodNotAllowed(response, ['GET'])
  noStore(response)
  const admin = await getAdminSession(request)
  if (!admin) return response.status(403).json({ message: 'Administrator access is required.' })

  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('clan_applications')
    .select('*')
    .order('submitted_at', { ascending: false })
    .limit(100)

  if (error) {
    console.error('Admin application list failed:', error.message)
    return response.status(503).json({ message: 'Unable to load applications.' })
  }

  return response.status(200).json({ applications: data ?? [] })
}
