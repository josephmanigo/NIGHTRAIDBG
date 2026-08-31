interface DiscordGuildJoinDependencies {
  accessToken: (discordUserId: string, forceRefresh: boolean) => Promise<string>
  validateAccessToken?: (accessToken: string) => Promise<void>
  addMember: (discordUserId: string, accessToken: string, roleIds: string[]) => Promise<boolean>
}

type DiscordFailure = Error & {
  discordCode?: number | string
  discordStatus?: number
}

function discordFailure(reason: unknown) {
  return reason instanceof Error ? reason as DiscordFailure : undefined
}

export function isInvalidDiscordOAuthToken(reason: unknown) {
  const failure = discordFailure(reason)
  return failure?.discordCode === 50025
    || failure?.discordCode === '50025'
    || /(?:invalid oauth2 access token|\b50025\b)/i.test(failure?.message || '')
}

function isUnauthorizedDiscordBearerToken(reason: unknown) {
  const failure = discordFailure(reason)
  return failure?.discordStatus === 401
}

export function isRejectedDiscordRefreshGrant(reason: unknown) {
  const failure = discordFailure(reason)
  return failure?.discordCode === 'invalid_grant'
    || failure?.discordCode === 'invalid_token'
    || ([400, 401].includes(failure?.discordStatus || 0)
      && /(?:invalid|expired|revoked).*(?:grant|token)|(?:grant|token).*(?:invalid|expired|revoked)/i.test(failure?.message || ''))
}

const RECONNECT_MESSAGE = 'The saved Discord authorization is no longer valid. Ask the applicant to reconnect Discord from the application status page, then retry onboarding.'

export async function addDiscordGuildMemberWithTokenRecovery(
  discordUserId: string,
  roleIds: string[],
  dependencies: DiscordGuildJoinDependencies,
) {
  const acquireAccessToken = async (forceRefresh: boolean) => {
    const token = await dependencies.accessToken(discordUserId, forceRefresh)
    await dependencies.validateAccessToken?.(token)
    return token
  }

  let accessToken: string
  try {
    accessToken = await acquireAccessToken(false)
  } catch (reason) {
    if (!isUnauthorizedDiscordBearerToken(reason)) throw reason
    accessToken = await acquireAccessToken(true)
  }

  try {
    return await dependencies.addMember(discordUserId, accessToken, roleIds)
  } catch (reason) {
    if (!isInvalidDiscordOAuthToken(reason)) throw reason
  }

  let refreshedAccessToken: string
  try {
    refreshedAccessToken = await acquireAccessToken(true)
  } catch (reason) {
    if (isUnauthorizedDiscordBearerToken(reason)) throw new Error(RECONNECT_MESSAGE)
    throw reason
  }
  try {
    return await dependencies.addMember(discordUserId, refreshedAccessToken, roleIds)
  } catch (reason) {
    if (isInvalidDiscordOAuthToken(reason)) throw new Error(RECONNECT_MESSAGE)
    throw reason
  }
}
