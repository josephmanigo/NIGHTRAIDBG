import type { VercelRequest, VercelResponse } from '@vercel/node'
import { methodNotAllowed, noStore } from '../../server/http.js'
import { getSession } from '../../server/session.js'
import { getSupabaseAdmin } from '../../server/supabase.js'

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'GET') return methodNotAllowed(response, ['GET'])
  noStore(response)
  const session = await getSession(request)
  if (!session) return response.status(401).json({ message: 'Connect Discord to view your application.' })

  const { data, error } = await getSupabaseAdmin()
    .from('clan_applications')
    .select(
      'application_number,in_game_name,games,status,decision_reason,submitted_at,reviewed_at,discord_membership_verified,discord_onboarding_status,assigned_discord_roles,discord_onboarded_at,discord_onboarding_error,ai_evaluation_status,ai_evaluated_at',
    )
    .eq('discord_user_id', session.discordUserId)
    .order('submitted_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) return response.status(503).json({ message: 'Unable to load the application status.' })
  return response.status(200).json({ application: data ?? null })
}
