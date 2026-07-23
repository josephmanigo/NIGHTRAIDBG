// Routed through the consolidated Vercel API function.
import { z } from 'zod'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { allowAdminMutation, getAdminSession } from '../../../../server/admin-request.js'
import { MembershipConflictError, removeMember } from '../../../../server/membership-exit.js'
import { hasTrustedOrigin, methodNotAllowed, requestBody, singleQueryValue } from '../../../../server/http.js'

const removalSchema = z
  .object({
    reason: z.string().trim().min(2).max(500),
    kickFromDiscord: z.boolean().optional().default(false),
  })
  .strict()

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'POST') return methodNotAllowed(response, ['POST'])
  if (!hasTrustedOrigin(request)) return response.status(403).json({ message: 'Untrusted request origin.' })
  const admin = await getAdminSession(request)
  if (!admin) return response.status(403).json({ message: 'Administrator access is required.' })
  if (!(await allowAdminMutation(request, response, admin.discordUserId))) return
  const id = singleQueryValue(request.query.id)
  if (!id) return response.status(400).json({ message: 'Application ID is required.' })
  const parsed = removalSchema.safeParse(requestBody(request))
  if (!parsed.success) return response.status(400).json({ message: 'A removal reason is required.' })

  try {
    const result = await removeMember({
      applicationId: id,
      reason: parsed.data.reason,
      kickFromDiscord: parsed.data.kickFromDiscord,
      removedBy: admin.discordUserId,
      request,
    })
    const notes = [
      parsed.data.kickFromDiscord
        ? 'The member was removed from NightRaid and kicked from the Discord server.'
        : 'The member was removed from NightRaid and their game roles were cleared.',
      result.discordCleanup === 'FAILED' ? 'The Discord cleanup failed and may need manual attention.' : null,
      result.memberNotification === 'FAILED' ? 'The Discord DM could not be delivered.' : null,
      result.rosterRemoval === 'FAILED' ? 'Their Google Sheet roster row could not be deleted.' : null,
    ].filter(Boolean)
    return response.status(200).json({ ...result, message: notes.join(' ') })
  } catch (reason) {
    if (reason instanceof MembershipConflictError) return response.status(409).json({ message: reason.message })
    console.error('Member removal failed:', reason instanceof Error ? reason.message : 'Unknown error')
    return response.status(503).json({ message: 'Unable to remove this member.' })
  }
}

export const config = { maxDuration: 60 }
