import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { isAdminDiscordId } from '../../server/admin.js'
import {
  approveApplication,
  DecisionConflictError,
  rejectApplication,
} from '../../server/application-decisions.js'
import { env } from '../../server/env.js'
import { methodNotAllowed, noStore, requestBody, singleQueryValue } from '../../server/http.js'
import { getSupabaseAdmin } from '../../server/supabase.js'

const SIGNATURE_MAX_AGE_MS = 5 * 60 * 1_000
const decidedStatuses = new Set(['APPROVED', 'COMPLETED', 'DISCORD_JOIN_FAILED', 'REJECTED'])

const actionSchema = z
  .object({
    action: z.enum(['APPROVE', 'REJECT']),
    applicationId: z.string().uuid(),
    adminDiscordId: z.string().regex(/^\d{16,22}$/),
    reason: z.string().trim().min(2).max(500).nullable().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.action === 'REJECT' && !value.reason) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: 'A rejection reason is required.',
      })
    }
  })

type DiscordAction = z.infer<typeof actionSchema>

function canonicalAction(timestamp: string, action: DiscordAction) {
  return [
    timestamp,
    action.action,
    action.applicationId,
    action.adminDiscordId,
    action.reason ?? '',
  ].join('\n')
}

function hasValidSignature(request: VercelRequest, action: DiscordAction) {
  const timestamp = singleQueryValue(request.headers['x-nightraid-timestamp'])
  const signature = singleQueryValue(request.headers['x-nightraid-signature'])
  if (!timestamp || !signature || !/^\d{13}$/.test(timestamp) || !/^[a-f0-9]{64}$/i.test(signature)) return false

  const issuedAt = Number(timestamp)
  if (!Number.isSafeInteger(issuedAt) || Math.abs(Date.now() - issuedAt) > SIGNATURE_MAX_AGE_MS) return false

  const expected = createHmac('sha256', env.applicationSigningSecret())
    .update(canonicalAction(timestamp, action))
    .digest('hex')
  const providedBuffer = Buffer.from(signature, 'hex')
  const expectedBuffer = Buffer.from(expected, 'hex')
  return providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer)
}

async function currentDecision(applicationId: string) {
  const { data } = await getSupabaseAdmin()
    .from('clan_applications')
    .select('application_number,status')
    .eq('id', applicationId)
    .maybeSingle()
  return data && decidedStatuses.has(data.status) ? data : null
}

export default async function handler(request: VercelRequest, response: VercelResponse) {
  noStore(response)
  if (request.method !== 'POST') return methodNotAllowed(response, ['POST'])

  const parsed = actionSchema.safeParse(requestBody(request))
  if (!parsed.success) return response.status(400).json({ message: 'Invalid Discord application action.' })
  if (!hasValidSignature(request, parsed.data)) {
    return response.status(401).json({ message: 'The Discord action signature is invalid or expired.' })
  }
  if (!isAdminDiscordId(parsed.data.adminDiscordId)) {
    return response.status(403).json({ message: 'This Discord account is not an authorized NIGHTRAID administrator.' })
  }

  try {
    if (parsed.data.action === 'APPROVE') {
      const result = await approveApplication({
        applicationId: parsed.data.applicationId,
        source: 'DISCORD',
        decidedBy: parsed.data.adminDiscordId,
        request,
      })
      return response.status(200).json({
        decision: 'APPROVED',
        applicationNumber: result.application.application_number,
        message:
          result.onboarding.status === 'COMPLETED'
            ? 'Application approved and Discord onboarding completed.'
            : 'Application approved. Discord onboarding needs an administrator retry.',
      })
    }

    const result = await rejectApplication({
      applicationId: parsed.data.applicationId,
      reason: parsed.data.reason!,
      source: 'DISCORD',
      decidedBy: parsed.data.adminDiscordId,
      request,
    })
    return response.status(200).json({
      decision: 'REJECTED',
      applicationNumber: result.application.application_number,
      message:
        result.applicantNotification === 'COMPLETED'
          ? 'Application rejected and the applicant was notified through Discord.'
          : 'Application rejected, but the applicant Discord DM failed.',
    })
  } catch (reason) {
    if (reason instanceof DecisionConflictError) {
      return response.status(409).json({ message: reason.message })
    }

    /*
     * Approval is atomic before onboarding begins. If onboarding fails after
     * the decision, report the recorded outcome instead of inviting a second
     * click that can never succeed.
     */
    const decided = await currentDecision(parsed.data.applicationId).catch(() => null)
    if (decided) {
      return response.status(200).json({
        decision: decided.status === 'REJECTED' ? 'REJECTED' : 'APPROVED',
        applicationNumber: decided.application_number,
        message:
          decided.status === 'REJECTED'
            ? 'Application rejected. Applicant notification may need attention.'
            : 'Application approved. Discord onboarding needs an administrator retry.',
      })
    }

    console.error(
      'Discord application decision failed:',
      reason instanceof Error ? reason.message : 'Unknown decision error',
    )
    return response.status(503).json({ message: 'The application decision could not be completed.' })
  }
}

export const config = { maxDuration: 60 }
