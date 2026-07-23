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
  const applications = data ?? []
  if (applications.length === 0) return response.status(200).json({ applications })

  const { data: evaluations, error: evaluationError } = await supabase
    .from('ai_evaluations')
    .select('*')
    .in('application_id', applications.map((application) => application.id))
    .order('created_at', { ascending: false })
    .limit(500)

  if (evaluationError) {
    console.error('Admin AI evaluation list failed:', evaluationError.message)
    return response.status(503).json({ message: 'Unable to load AI application reviews.' })
  }

  const latestByApplication = new Map<string, (typeof evaluations)[number]>()
  for (const evaluation of evaluations ?? []) {
    if (!latestByApplication.has(evaluation.application_id)) {
      latestByApplication.set(evaluation.application_id, evaluation)
    }
  }

  return response.status(200).json({
    applications: applications.map((application) => ({
      ...application,
      ai_evaluation: latestByApplication.get(application.id) ?? null,
    })),
  })
}
