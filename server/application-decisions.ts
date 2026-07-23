import type { VercelRequest } from '@vercel/node'
import { recordAuditEvent } from './audit.js'
import { acceptedApplicantDiscordMessage, sendDiscordDirectMessage } from './discord.js'
import { onboardApprovedApplication, type DiscordOnboardingResult } from './discord-onboarding.js'
import { syncExcelRegister } from './excel-sync.js'
import { syncApprovedApplicationToGoogleSheet } from './google-sheets-sync.js'
import { getSupabaseAdmin } from './supabase.js'

export type DecisionSource = 'WEB' | 'MESSENGER'

export class DecisionConflictError extends Error {
  constructor() {
    super('This application is no longer pending.')
  }
}

type ApplicantNotificationResult =
  | { applicantNotification: 'COMPLETED'; notificationError?: never }
  | { applicantNotification: 'FAILED'; notificationError: string }

async function notifyApplicant(discordUserId: string, message: string): Promise<ApplicantNotificationResult> {
  try {
    await sendDiscordDirectMessage(discordUserId, message)
    return { applicantNotification: 'COMPLETED' }
  } catch (reason) {
    const notificationError = reason instanceof Error ? reason.message.slice(0, 300) : 'Discord notification failed.'
    console.error('Applicant Discord decision notification failed:', notificationError)
    return { applicantNotification: 'FAILED', notificationError }
  }
}

async function decide(input: {
  applicationId: string
  decision: 'APPROVED' | 'REJECTED'
  reason: string | null
  source: DecisionSource
  decidedBy: string
  request?: VercelRequest
}) {
  const { data, error } = await getSupabaseAdmin()
    .rpc('decide_clan_application', {
      p_application_id: input.applicationId,
      p_decision: input.decision,
      p_reason: input.reason,
      p_source: input.source,
      p_decided_by: input.decidedBy,
    })
    .single()

  if (error) {
    if (error.code === 'P0001' || error.message.includes('APPLICATION_NOT_PENDING')) throw new DecisionConflictError()
    throw new Error(`The application decision could not be saved: ${error.message}`)
  }
  await recordAuditEvent({
    actorType: input.source === 'WEB' ? 'ADMIN' : 'MESSENGER_ADMIN',
    actorId: input.decidedBy,
    action: input.decision === 'APPROVED' ? 'APPLICATION_APPROVED' : 'APPLICATION_REJECTED',
    applicationId: data.id,
    targetType: 'clan_application',
    targetId: data.application_number,
    details: { source: input.source },
    request: input.request,
  })
  return data
}

export async function approveApplication(input: {
  applicationId: string
  source: DecisionSource
  decidedBy: string
  request?: VercelRequest
}) {
  const application = await decide({
    ...input,
    decision: 'APPROVED',
    reason: null,
  })

  const sendAcceptanceMessage = () =>
    notifyApplicant(
      application.discord_user_id,
      acceptedApplicantDiscordMessage({
        applicationNumber: application.application_number,
        inGameName: application.in_game_name,
        games: application.games,
        onboardingComplete: false,
      }),
    )

  /* Onboarding sends the welcome DM itself, so the acceptance DM is only a
   * fallback for when that message did not go out. The applicant receives
   * exactly one notification either way. */
  let onboarding: DiscordOnboardingResult
  try {
    onboarding = await onboardApprovedApplication(application.id)
  } catch (reason) {
    await sendAcceptanceMessage()
    throw reason
  }
  const notification: ApplicantNotificationResult =
    onboarding.welcomeNotification === 'COMPLETED'
      ? { applicantNotification: 'COMPLETED' }
      : await sendAcceptanceMessage()

  const [excelSync, googleSheetsSync] = await Promise.all([
    syncExcelRegister([application.id], input.decidedBy),
    syncApprovedApplicationToGoogleSheet(application.id, input.decidedBy),
  ])
  return { application, onboarding, excelSync, googleSheetsSync, ...notification }
}

export async function rejectApplication(input: {
  applicationId: string
  reason: string
  source: DecisionSource
  decidedBy: string
  request?: VercelRequest
}) {
  const application = await decide({
    ...input,
    decision: 'REJECTED',
    reason: input.reason,
  })

  const notification = await notifyApplicant(
    application.discord_user_id,
    `Thank you for applying to NIGHTRAID. Your application ${application.application_number} was not accepted at this time. Reason: ${input.reason}. You can review the recorded decision in the NIGHTRAID application status portal.`,
  )
  const excelSync = await syncExcelRegister([application.id], input.decidedBy)
  return { application, excelSync, ...notification }
}
