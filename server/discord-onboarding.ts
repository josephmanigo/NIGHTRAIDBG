import { decryptSecret, encryptSecret } from './encryption.js'
import {
  addDiscordGuildMember,
  addDiscordMemberRole,
  fetchDiscordBotUser,
  fetchDiscordGuildRoles,
  fetchDiscordOAuthAuthorization,
  nightNickname,
  refreshDiscordToken,
  sendDiscordWelcomeMessage,
  setDiscordMemberNickname,
} from './discord.js'
import { env } from './env.js'
import { getSupabaseAdmin } from './supabase.js'
import { resolveDiscordGameRoles } from './discord-role-resolution.js'
import {
  addDiscordGuildMemberWithTokenRecovery,
  isRejectedDiscordRefreshGrant,
} from './discord-token-recovery.js'
import { validateDiscordOnboardingIdentity } from './discord-onboarding-identity.js'

const CLAIMABLE_APPLICATION_STATUSES = ['APPROVED', 'DISCORD_JOIN_FAILED']
const CLAIMABLE_ONBOARDING_STATUSES = ['NOT_STARTED', 'FAILED']

export interface DiscordOnboardingResult {
  status: 'COMPLETED' | 'DISCORD_JOIN_FAILED'
  assignedRoles: string[]
  nicknameApplied?: boolean
  welcomeNotification?: 'COMPLETED' | 'FAILED'
  error?: string
}

function safeError(reason: unknown) {
  const message = reason instanceof Error ? reason.message : 'Discord onboarding failed.'
  return message.slice(0, 500)
}

export async function validDiscordAccessToken(
  discordUserId: string,
  options: { forceRefresh?: boolean } = {},
) {
  const supabase = getSupabaseAdmin()
  const { data: connection, error } = await supabase
    .from('discord_connections')
    .select('encrypted_access_token,encrypted_refresh_token,token_expires_at')
    .eq('discord_user_id', discordUserId)
    .maybeSingle()

  if (error || !connection) throw new Error('The applicant must reconnect Discord before onboarding.')

  const expiresAt = connection.token_expires_at ? new Date(connection.token_expires_at).getTime() : 0
  if (!options.forceRefresh && expiresAt > Date.now() + 60_000) {
    return decryptSecret(connection.encrypted_access_token)
  }
  if (!connection.encrypted_refresh_token) throw new Error('The Discord authorization expired. Ask the applicant to reconnect Discord.')

  const refreshToken = decryptSecret(connection.encrypted_refresh_token)
  let refreshed
  try {
    refreshed = await refreshDiscordToken(refreshToken)
  } catch (reason) {
    if (isRejectedDiscordRefreshGrant(reason)) {
      throw new Error('The saved Discord authorization is no longer valid. Ask the applicant to reconnect Discord from the application status page, then retry onboarding.')
    }
    throw reason
  }
  if (!refreshed.scope.split(/\s+/).includes('guilds.join')) {
    throw new Error('The saved Discord authorization is missing guilds.join. Ask the applicant to reconnect Discord from the application status page, then retry onboarding.')
  }
  const nextExpiry = new Date(Date.now() + refreshed.expires_in * 1000).toISOString()
  const { error: updateError } = await supabase
    .from('discord_connections')
    .update({
      encrypted_access_token: encryptSecret(refreshed.access_token),
      encrypted_refresh_token: encryptSecret(refreshed.refresh_token || refreshToken),
      token_expires_at: nextExpiry,
      updated_at: new Date().toISOString(),
    })
    .eq('discord_user_id', discordUserId)

  if (updateError) throw new Error('The refreshed Discord authorization could not be saved.')
  return refreshed.access_token
}

async function resolveRoles(games: string[]) {
  const guildRoles = await fetchDiscordGuildRoles()
  const configuredGameRoles = env.discordGameRoleIds()
  return resolveDiscordGameRoles(games, guildRoles, configuredGameRoles)
}

async function writeOnboardingLog(input: {
  applicationId: string
  discordUserId: string
  assignedRoles: string[]
  status: 'COMPLETED' | 'FAILED'
  error?: string
}) {
  const { error } = await getSupabaseAdmin().from('discord_onboarding_logs').insert({
    application_id: input.applicationId,
    discord_user_id: input.discordUserId,
    guild_id: env.discordGuildId(),
    assigned_roles: input.assignedRoles,
    status: input.status,
    error_message: input.error || null,
  })
  if (error) console.error('Discord onboarding log failed:', error.message)
}

export async function onboardApprovedApplication(applicationId: string): Promise<DiscordOnboardingResult> {
  const supabase = getSupabaseAdmin()
  const now = new Date().toISOString()
  const { data: application, error: claimError } = await supabase
    .from('clan_applications')
    .update({
      discord_onboarding_status: 'PROCESSING',
      discord_onboarding_error: null,
      updated_at: now,
    })
    .eq('id', applicationId)
    .in('status', CLAIMABLE_APPLICATION_STATUSES)
    .in('discord_onboarding_status', CLAIMABLE_ONBOARDING_STATUSES)
    .select('id,application_number,discord_user_id,in_game_name,games')
    .maybeSingle()

  if (claimError) throw new Error('Discord onboarding could not be started.')
  if (!application) throw new Error('Discord onboarding is already complete or in progress.')

  const assignedRoles: string[] = []
  let memberPresent = false
  try {
    const roles = await resolveRoles(application.games)
    const botUser = await fetchDiscordBotUser()
    const memberCreated = await addDiscordGuildMemberWithTokenRecovery(
      application.discord_user_id,
      roles.map((role) => role.id),
      {
        accessToken: (discordUserId, forceRefresh) => validDiscordAccessToken(discordUserId, { forceRefresh }),
        validateAccessToken: async (accessToken) => {
          const grant = await fetchDiscordOAuthAuthorization(accessToken)
          validateDiscordOnboardingIdentity({
            expectedApplicationId: env.discordClientId(),
            expectedDiscordUserId: application.discord_user_id,
            botUserId: botUser.id,
            grantApplicationId: grant.application.id,
            grantDiscordUserId: grant.user?.id,
            grantScopes: grant.scopes,
          })
        },
        addMember: addDiscordGuildMember,
      },
    )
    memberPresent = true
    if (memberCreated) {
      assignedRoles.push(...roles.map((role) => role.name))
    } else {
      for (const role of roles) {
        await addDiscordMemberRole(application.discord_user_id, role.id)
        assignedRoles.push(role.name)
      }
    }

    /* Best effort: an unmanageable member (server owner, higher role) keeps
     * their own nickname and simply gets the manual instructions instead. */
    let nicknameApplied = false
    try {
      nicknameApplied = await setDiscordMemberNickname(
        application.discord_user_id,
        nightNickname(application.in_game_name),
      )
    } catch (reason) {
      console.error('Discord onboarding nickname update failed:', safeError(reason))
    }

    let welcomeNotification: 'COMPLETED' | 'FAILED' = 'COMPLETED'
    try {
      await sendDiscordWelcomeMessage(
        application.discord_user_id,
        application.application_number,
        application.in_game_name,
        application.games,
        nicknameApplied,
      )
    } catch (reason) {
      welcomeNotification = 'FAILED'
      console.error('Discord onboarding welcome message failed:', safeError(reason))
    }

    const completedAt = new Date().toISOString()
    const { error: completeError } = await supabase
      .from('clan_applications')
      .update({
        status: 'COMPLETED',
        discord_onboarding_status: 'COMPLETED',
        discord_membership_verified: true,
        assigned_discord_roles: assignedRoles,
        discord_onboarded_at: completedAt,
        discord_onboarding_error: null,
        updated_at: completedAt,
      })
      .eq('id', application.id)
    if (completeError) throw new Error('Discord onboarding completed, but the application status could not be updated.')

    await writeOnboardingLog({
      applicationId: application.id,
      discordUserId: application.discord_user_id,
      assignedRoles,
      status: 'COMPLETED',
    })
    return { status: 'COMPLETED', assignedRoles, nicknameApplied, welcomeNotification }
  } catch (reason) {
    const message = safeError(reason)
    const failedAt = new Date().toISOString()
    const { error: failureUpdateError } = await supabase
      .from('clan_applications')
      .update({
        status: 'DISCORD_JOIN_FAILED',
        discord_onboarding_status: 'FAILED',
        assigned_discord_roles: assignedRoles,
        discord_onboarding_error: message,
        ...(memberPresent ? { discord_membership_verified: true } : {}),
        updated_at: failedAt,
      })
      .eq('id', application.id)
    if (failureUpdateError) console.error('Discord onboarding failure status could not be saved:', failureUpdateError.message)

    await writeOnboardingLog({
      applicationId: application.id,
      discordUserId: application.discord_user_id,
      assignedRoles,
      status: 'FAILED',
      error: message,
    })
    return { status: 'DISCORD_JOIN_FAILED', assignedRoles, error: message }
  }
}
