export type ApplicantNotificationResult =
  | { applicantNotification: 'COMPLETED'; notificationError?: never }
  | { applicantNotification: 'PORTAL_ONLY'; notificationError?: never }
  | { applicantNotification: 'FAILED'; notificationError: string }

export interface ApplicantNotificationDependencies {
  fetchMember: (discordUserId: string) => Promise<unknown | null>
  validAccessToken: (discordUserId: string) => Promise<string>
  addMember: (discordUserId: string, accessToken: string) => Promise<boolean>
  sendDirectMessage: (discordUserId: string, message: string) => Promise<unknown>
  removeMember: (discordUserId: string) => Promise<unknown>
  reportError: (stage: 'access' | 'delivery' | 'cleanup', error: string) => void
}

function safeNotificationError(reason: unknown, fallback: string) {
  return (reason instanceof Error ? reason.message : fallback).replace(/\s+/g, ' ').slice(0, 300)
}

export async function notifyApplicantThroughDiscord(
  discordUserId: string,
  message: string,
  options: { temporarilyJoinForDelivery?: boolean },
  dependencies: ApplicantNotificationDependencies,
): Promise<ApplicantNotificationResult> {
  let temporaryMemberAdded = false
  try {
    const member = await dependencies.fetchMember(discordUserId)
    if (!member) {
      if (!options.temporarilyJoinForDelivery) return { applicantNotification: 'PORTAL_ONLY' }
      const accessToken = await dependencies.validAccessToken(discordUserId)
      temporaryMemberAdded = await dependencies.addMember(discordUserId, accessToken)
    }
  } catch (reason) {
    const notificationError = safeNotificationError(reason, 'Discord access failed.')
    dependencies.reportError('access', notificationError)
    return { applicantNotification: 'FAILED', notificationError }
  }

  try {
    await dependencies.sendDirectMessage(discordUserId, message)
    return { applicantNotification: 'COMPLETED' }
  } catch (reason) {
    const notificationError = safeNotificationError(reason, 'Discord notification failed.')
    dependencies.reportError('delivery', notificationError)
    return { applicantNotification: 'FAILED', notificationError }
  } finally {
    if (temporaryMemberAdded) {
      try {
        await dependencies.removeMember(discordUserId)
      } catch (reason) {
        dependencies.reportError('cleanup', safeNotificationError(reason, 'Discord cleanup failed.'))
      }
    }
  }
}
