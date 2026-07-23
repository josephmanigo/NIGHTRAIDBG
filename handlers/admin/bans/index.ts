// Routed through the consolidated Vercel API function.
import { z } from 'zod'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { allowAdminMutation, getAdminSession } from '../../../server/admin-request.js'
import { recordAuditEvent } from '../../../server/audit.js'
import { hasTrustedOrigin, methodNotAllowed, requestBody } from '../../../server/http.js'
import { getSupabaseAdmin } from '../../../server/supabase.js'

const banSchema = z
  .object({
    applicationId: z.string().uuid().optional(),
    discordUserId: z.string().trim().regex(/^\d{16,22}$/).optional(),
    inGameName: z.string().trim().min(2).max(50).optional(),
    facebookProfileUrl: z.string().trim().url().max(300).optional(),
    reason: z.string().trim().min(2).max(500),
  })
  .strict()
  .refine(
    (value) => Boolean(value.applicationId || value.discordUserId || value.inGameName || value.facebookProfileUrl),
    'At least one ban identifier is required.',
  )

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'POST') return methodNotAllowed(response, ['POST'])
  if (!hasTrustedOrigin(request)) return response.status(403).json({ message: 'Untrusted request origin.' })
  const admin = await getAdminSession(request)
  if (!admin) return response.status(403).json({ message: 'Administrator access is required.' })
  if (!(await allowAdminMutation(request, response, admin.discordUserId))) return

  const parsed = banSchema.safeParse(requestBody(request))
  if (!parsed.success) return response.status(400).json({ message: 'The ban information is invalid.' })

  const supabase = getSupabaseAdmin()
  let application:
    | { id: string; discord_user_id: string; in_game_name: string; facebook_profile_url: string }
    | null = null
  if (parsed.data.applicationId) {
    const result = await supabase
      .from('clan_applications')
      .select('id,discord_user_id,in_game_name,facebook_profile_url')
      .eq('id', parsed.data.applicationId)
      .maybeSingle()
    if (result.error) return response.status(503).json({ message: 'Unable to load the selected application.' })
    if (!result.data) return response.status(404).json({ message: 'Application not found.' })
    application = result.data
  }

  const { data: ban, error } = await supabase
    .from('clan_bans')
    .insert({
      discord_user_id: parsed.data.discordUserId ?? application?.discord_user_id ?? null,
      in_game_name: parsed.data.inGameName ?? application?.in_game_name ?? null,
      facebook_profile_url: parsed.data.facebookProfileUrl ?? application?.facebook_profile_url ?? null,
      reason: parsed.data.reason,
      is_active: true,
      banned_by: admin.discordUserId,
    })
    .select('*')
    .single()

  if (error) {
    if (error.code === '23505') return response.status(409).json({ message: 'An active ban already covers this applicant.' })
    console.error('Ban creation failed:', error.message)
    return response.status(503).json({ message: 'Unable to create the ban.' })
  }

  await recordAuditEvent({
    actorType: 'ADMIN',
    actorId: admin.discordUserId,
    action: 'CLAN_BAN_CREATED',
    applicationId: application?.id ?? null,
    targetType: 'clan_ban',
    targetId: ban.id,
    details: { identifiers: [ban.discord_user_id && 'discord', ban.in_game_name && 'ign', ban.facebook_profile_url && 'facebook'].filter(Boolean) },
    request,
  })

  return response.status(201).json({ ban, message: 'Applicant ban activated.' })
}
