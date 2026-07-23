// Routed through the consolidated Vercel API function.
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { allowAdminMutation, getAdminSession } from '../../../../server/admin-request.js'
import { recordAuditEvent } from '../../../../server/audit.js'
import { hasTrustedOrigin, methodNotAllowed, singleQueryValue } from '../../../../server/http.js'
import { getSupabaseAdmin } from '../../../../server/supabase.js'

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'POST') return methodNotAllowed(response, ['POST'])
  if (!hasTrustedOrigin(request)) return response.status(403).json({ message: 'Untrusted request origin.' })
  const admin = await getAdminSession(request)
  if (!admin) return response.status(403).json({ message: 'Administrator access is required.' })
  if (!(await allowAdminMutation(request, response, admin.discordUserId))) return
  const id = singleQueryValue(request.query.id)
  if (!id) return response.status(400).json({ message: 'Ban ID is required.' })

  const { data: ban, error } = await getSupabaseAdmin()
    .from('clan_bans')
    .update({
      is_active: false,
      deactivated_at: new Date().toISOString(),
      deactivated_by: admin.discordUserId,
    })
    .eq('id', id)
    .eq('is_active', true)
    .select('*')
    .maybeSingle()

  if (error) {
    console.error('Ban deactivation failed:', error.message)
    return response.status(503).json({ message: 'Unable to deactivate the ban.' })
  }
  if (!ban) return response.status(409).json({ message: 'This ban is already inactive or no longer exists.' })

  await recordAuditEvent({
    actorType: 'ADMIN',
    actorId: admin.discordUserId,
    action: 'CLAN_BAN_DEACTIVATED',
    targetType: 'clan_ban',
    targetId: ban.id,
    request,
  })

  return response.status(200).json({ ban, message: 'Applicant ban deactivated.' })
}
