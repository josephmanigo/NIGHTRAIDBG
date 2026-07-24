import type { VercelRequest } from '@vercel/node'
import { recordAuditEvent } from './audit.js'
import {
  fetchDiscordGuildRoles,
  removeDiscordGuildMember,
  removeDiscordMemberRole,
  sendDiscordDirectMessage,
} from './discord.js'
import { syncExcelRegister } from './excel-sync.js'
import { removeApplicationFromGoogleSheet } from './google-sheets-sync.js'
import { getSupabaseAdmin } from './supabase.js'

export const ACTIVE_MEMBER_STATUSES = ['APPROVED', 'DISCORD_JOIN_FAILED', 'COMPLETED']

export class MembershipConflictError extends Error {
  constructor() {
    super('This player is not an active NIGHTRAID member.')
  }
}

export interface MembershipExitResult {
  application: {
    id: string
    application_number: string
    discord_user_id: string
    in_game_name: string
    assigned_discord_roles: string[]
  }
  discordCleanup: 'COMPLETED' | 'FAILED'
  memberNotification: 'COMPLETED' | 'FAILED'
  rosterRemoval: 'REMOVED' | 'NOT_FOUND' | 'SKIPPED' | 'FAILED'
}

function safeError(reason: unknown, fallback: string) {
  return (reason instanceof Error ? reason.message : fallback).slice(0, 300)
}

/* assigned_discord_roles stores role names, so they are resolved back to IDs
 * against the live guild role list before removal. */
async function clearAssignedRoles(discordUserId: string, roleNames: string[]) {
  if (roleNames.length === 0) return
  const guildRoles = await fetchDiscordGuildRoles()
  for (const name of roleNames) {
    const role = guildRoles.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase())
    if (role) await removeDiscordMemberRole(discordUserId, role.id)
  }
}

async function closeMembership(input: {
  claim: () => ReturnType<typeof claimByApplicationId>
  nextStatus: 'REMOVED' | 'LEFT'
  message: (applicationNumber: string, inGameName: string) => string
  kickFromDiscord: boolean
  actorType: 'ADMIN' | 'APPLICANT'
  actorId: string
  details: Record<string, string | boolean>
  request?: VercelRequest
}): Promise<MembershipExitResult> {
  const application = await input.claim()
  if (!application) throw new MembershipConflictError()

  /* The DM goes out before any Discord kick: once the member no longer shares
   * a server with the bot, direct messages can stop being deliverable. */
  let memberNotification: 'COMPLETED' | 'FAILED' = 'COMPLETED'
  try {
    await sendDiscordDirectMessage(
      application.discord_user_id,
      input.message(application.application_number, application.in_game_name),
    )
  } catch (reason) {
    memberNotification = 'FAILED'
    console.error('Membership exit notification failed:', safeError(reason, 'Discord notification failed.'))
  }

  let discordCleanup: 'COMPLETED' | 'FAILED' = 'COMPLETED'
  try {
    if (input.kickFromDiscord) {
      await removeDiscordGuildMember(application.discord_user_id)
    } else {
      await clearAssignedRoles(application.discord_user_id, application.assigned_discord_roles)
    }
  } catch (reason) {
    discordCleanup = 'FAILED'
    console.error('Membership exit Discord cleanup failed:', safeError(reason, 'Discord cleanup failed.'))
  }

  /* The Google Sheet is the live accepted-member roster, so an exit deletes
   * the row entirely; the Excel register keeps the row as history instead. */
  const rosterRemoval = (await removeApplicationFromGoogleSheet(application.application_number)).status

  await recordAuditEvent({
    actorType: input.actorType,
    actorId: input.actorId,
    action: input.nextStatus === 'REMOVED' ? 'MEMBER_REMOVED' : 'MEMBER_LEFT',
    applicationId: application.id,
    targetType: 'clan_application',
    targetId: application.application_number,
    details: { ...input.details, discordCleanup, memberNotification, rosterRemoval },
    request: input.request,
  })

  try {
    await syncExcelRegister([application.id], input.actorId)
  } catch (reason) {
    console.error('Membership exit Excel sync failed:', safeError(reason, 'Excel sync failed.'))
  }

  return { application, discordCleanup, memberNotification, rosterRemoval }
}

const CLAIM_COLUMNS = 'id,application_number,discord_user_id,in_game_name,assigned_discord_roles'

async function claimByApplicationId(applicationId: string, nextStatus: 'REMOVED' | 'LEFT', reason: string | null) {
  const now = new Date().toISOString()
  const { data, error } = await getSupabaseAdmin()
    .from('clan_applications')
    .update({ status: nextStatus, decision_reason: reason, updated_at: now })
    .eq('id', applicationId)
    .in('status', ACTIVE_MEMBER_STATUSES)
    .select(CLAIM_COLUMNS)
    .maybeSingle()
  if (error) throw new Error(`The membership status could not be updated: ${error.message}`)
  return data
}

export async function removeMember(input: {
  applicationId: string
  reason: string
  kickFromDiscord: boolean
  removedBy: string
  request?: VercelRequest
}) {
  return closeMembership({
    claim: () => claimByApplicationId(input.applicationId, 'REMOVED', input.reason),
    nextStatus: 'REMOVED',
    kickFromDiscord: input.kickFromDiscord,
    actorType: 'ADMIN',
    actorId: input.removedBy,
    details: { reason: input.reason, kickFromDiscord: input.kickFromDiscord },
    request: input.request,
    message: (applicationNumber) =>
      [
        '# NIGHTRAID // MEMBERSHIP ENDED',
        `> **APPLICATION ${applicationNumber}**`,
        '',
        'An administrator has removed you from the NIGHTRAID roster.',
        `**Reason:** ${input.reason}`,
        '',
        'Unless a ban is active, you are welcome to submit a new application in the future.',
      ].join('\n'),
  })
}

export async function leaveClan(input: { discordUserId: string; request?: VercelRequest }) {
  const { data: candidate, error } = await getSupabaseAdmin()
    .from('clan_applications')
    .select('id')
    .eq('discord_user_id', input.discordUserId)
    .in('status', ACTIVE_MEMBER_STATUSES)
    .order('submitted_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`The membership could not be loaded: ${error.message}`)
  if (!candidate) throw new MembershipConflictError()

  return closeMembership({
    claim: () => claimByApplicationId(candidate.id, 'LEFT', null),
    nextStatus: 'LEFT',
    kickFromDiscord: false,
    actorType: 'APPLICANT',
    actorId: input.discordUserId,
    details: { voluntary: true },
    request: input.request,
    message: (applicationNumber, inGameName) =>
      [
        '# NIGHTRAID // MEMBERSHIP CLOSED',
        `> **APPLICATION ${applicationNumber}**`,
        '',
        `You have left NIGHTRAID, ${inGameName}. Your game roles have been cleared and your membership is now closed.`,
        '',
        'The door stays open: you are welcome to apply again any time.',
      ].join('\n'),
  })
}
