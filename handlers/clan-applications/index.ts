// Routed through the consolidated Vercel API function.
import { randomInt } from 'node:crypto'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { evaluateApplication } from '../../server/ai-evaluation.js'
import { recordAuditEvent } from '../../server/audit.js'
import { findActiveBan } from '../../server/ban-list.js'
import { clanApplicationSchema } from '../../server/application-schema.js'
import { fetchDiscordGuildMember } from '../../server/discord.js'
import { notifyDiscordApplicationReview } from '../../server/discord-review-notifications.js'
import { syncExcelRegister } from '../../server/excel-sync.js'
import { getRequestOrigin, hasTrustedOrigin, methodNotAllowed, requestBody } from '../../server/http.js'
import { notifyMessengerAdmins } from '../../server/messenger-notifications.js'
import { consumeRateLimit, rateLimitResponse } from '../../server/rate-limit.js'
import { clearSessionCookie, getSession } from '../../server/session.js'
import { getSupabaseAdmin } from '../../server/supabase.js'

const OPEN_STATUSES = ['SUBMITTED', 'PROCESSING', 'PENDING_REVIEW', 'APPROVED', 'DISCORD_JOIN_FAILED']

function applicationNumber() {
  return `NR-${new Date().getFullYear()}-${String(randomInt(0, 1_000_000)).padStart(6, '0')}`
}

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'POST') return methodNotAllowed(response, ['POST'])
  if (!hasTrustedOrigin(request)) return response.status(403).json({ message: 'Untrusted request origin.' })

  const session = await getSession(request)
  if (!session) return response.status(401).json({ message: 'Connect Discord before submitting.' })

  const rateLimit = await consumeRateLimit({
    scope: 'application-submit',
    subject: session.discordUserId,
    request,
    limit: 5,
    windowSeconds: 15 * 60,
    blockSeconds: 30 * 60,
  })
  if (!rateLimit.allowed) {
    await recordAuditEvent({
      actorType: 'APPLICANT',
      actorId: session.discordUserId,
      action: 'APPLICATION_SUBMISSION_RATE_LIMITED',
      outcome: 'DENIED',
      request,
    })
    return rateLimitResponse(response, rateLimit)
  }

  const result = clanApplicationSchema.safeParse(requestBody(request))
  if (!result.success) {
    await recordAuditEvent({
      actorType: 'APPLICANT',
      actorId: session.discordUserId,
      action: 'APPLICATION_VALIDATION_FAILED',
      outcome: 'DENIED',
      details: { issueCount: result.error.issues.length },
      request,
    })
    return response.status(400).json({
      message: 'Please correct the highlighted application fields.',
      issues: result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    })
  }

  const supabase = getSupabaseAdmin()
  const { data: existing, error: duplicateError } = await supabase
    .from('clan_applications')
    .select('application_number,status')
    .eq('discord_user_id', session.discordUserId)
    .in('status', OPEN_STATUSES)
    .limit(1)
    .maybeSingle()

  if (duplicateError) {
    console.error('Application duplicate check failed:', duplicateError.message)
    return response.status(503).json({ message: 'Unable to verify your application right now.' })
  }
  if (existing) {
    await recordAuditEvent({
      actorType: 'APPLICANT',
      actorId: session.discordUserId,
      action: 'DUPLICATE_APPLICATION_BLOCKED',
      outcome: 'DENIED',
      targetType: 'clan_application',
      targetId: existing.application_number,
      request,
    })
    return response.status(409).json({
      message: `You already have an active application (${existing.application_number}).`,
      applicationId: existing.application_number,
      status: existing.status,
    })
  }

  const input = result.data
  let activeBan
  try {
    activeBan = await findActiveBan({
      discordUserId: session.discordUserId,
      inGameName: input.inGameName,
      facebookProfileUrl: input.facebookProfileUrl,
    })
  } catch (reason) {
    console.error('Application ban check failed:', reason instanceof Error ? reason.message : 'Unknown error')
    return response.status(503).json({ message: 'Unable to verify application eligibility right now.' })
  }
  if (activeBan) {
    await recordAuditEvent({
      actorType: 'APPLICANT',
      actorId: session.discordUserId,
      action: 'BANNED_APPLICATION_BLOCKED',
      outcome: 'DENIED',
      targetType: 'clan_ban',
      targetId: activeBan.id,
      request,
    })
    return response.status(403).json({ message: 'This application cannot be accepted. Contact a NIGHTRAID administrator.' })
  }

  const number = applicationNumber()
  let discordMembershipVerified: boolean | null = null
  try {
    discordMembershipVerified = Boolean(await fetchDiscordGuildMember(session.discordUserId))
  } catch (reason) {
    console.error(
      'Discord membership verification failed:',
      reason instanceof Error ? reason.message : 'Unknown Discord verification error',
    )
  }
  const { data: application, error } = await supabase.from('clan_applications').insert({
    application_number: number,
    discord_user_id: session.discordUserId,
    discord_username: session.discordUsername,
    in_game_name: input.inGameName,
    age_group: input.ageGroup,
    sex: input.sex,
    device: input.device,
    games: input.games,
    willing_to_use_clan_tag: input.willingToUseClanTag,
    play_frequency: input.playFrequency,
    previous_clan: input.previousClan,
    previous_clan_leaving_reason: input.previousClanLeavingReason,
    facebook_profile_url: input.facebookProfileUrl,
    discovery_source: input.discoverySource,
    discovery_source_other: input.discoverySourceOther || null,
    already_joined_discord: input.alreadyJoinedDiscord,
    discord_membership_verified: discordMembershipVerified,
    reason_for_joining: input.reasonForJoining,
    consent_accurate: input.consents.accurate,
    consent_rules: input.consents.rules,
    consent_false_information: input.consents.falseInfo,
    consent_processing: input.consents.processing,
    status: 'PENDING_REVIEW',
  }).select('id').single()

  if (error) {
    console.error('Application insert failed:', error.message)
    return response.status(error.code === '23505' ? 409 : 503).json({
      message: error.code === '23505' ? 'An active application already exists.' : 'The application could not be saved.',
    })
  }

  await recordAuditEvent({
    actorType: 'APPLICANT',
    actorId: session.discordUserId,
    action: 'APPLICATION_SUBMITTED',
    applicationId: application.id,
    targetType: 'clan_application',
    targetId: number,
    request,
  })

  let discordReviewStatus: 'COMPLETED' | 'FAILED' | 'SKIPPED' = 'SKIPPED'
  try {
    const notification = await notifyDiscordApplicationReview(application.id, getRequestOrigin(request))
    discordReviewStatus = notification.status
  } catch (reason) {
    discordReviewStatus = 'FAILED'
    console.error(
      'Application was saved but the Discord review notification could not start:',
      reason instanceof Error ? reason.message : 'Unknown error',
    )
  }

  let evaluationStatus: 'COMPLETED' | 'FAILED' = 'FAILED'
  try {
    const evaluation = await evaluateApplication(application.id)
    evaluationStatus = evaluation.status
  } catch (reason) {
    console.error('Application was saved but AI evaluation could not start:', reason instanceof Error ? reason.message : 'Unknown error')
  }

  let messengerStatus: 'COMPLETED' | 'FAILED' = 'FAILED'
  try {
    const notification = await notifyMessengerAdmins(application.id, getRequestOrigin(request))
    messengerStatus = notification.status
  } catch (reason) {
    console.error('Application was saved but Messenger notification could not start:', reason instanceof Error ? reason.message : 'Unknown error')
  }

  const excelSync = await syncExcelRegister([application.id])

  clearSessionCookie(response)
  return response.status(201).json({
    applicationId: number,
    status: 'PENDING_REVIEW',
    evaluationStatus,
    discordReviewStatus,
    messengerStatus,
    excelSyncStatus: excelSync.status,
  })
}

export const config = { maxDuration: 60 }
