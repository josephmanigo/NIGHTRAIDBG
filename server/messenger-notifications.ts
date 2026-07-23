import { sendDiscordAdminAlert } from './discord.js'
import { sendMessengerButtonTemplate, sendMessengerText, type MessengerButton } from './messenger.js'
import { signMessengerAction } from './messenger-security.js'
import { getSupabaseAdmin } from './supabase.js'

export interface MessengerNotificationResult {
  status: 'COMPLETED' | 'FAILED'
  delivered: number
  failed: number
  error?: string
}

function safeError(reason: unknown) {
  return (reason instanceof Error ? reason.message : 'Messenger notification failed.').replace(/\s+/g, ' ').slice(0, 500)
}

async function sendBackupAlert(applicationNumber: string, error: string) {
  try {
    await sendDiscordAdminAlert(
      `NIGHTRAID Messenger delivery failed for ${applicationNumber}. The application remains in the admin portal. Error: ${error.slice(0, 300)}`,
    )
  } catch (reason) {
    console.error('Backup Discord administrator alert failed:', safeError(reason))
  }
}

function applicationText(
  application: {
    application_number: string
    in_game_name: string
    age_group: string
    sex: string
    device: string
    games: string[]
    willing_to_use_clan_tag: boolean
    play_frequency: string
    previous_clan: string
    previous_clan_leaving_reason: string
    discovery_source: string
    discovery_source_other: string | null
    already_joined_discord: boolean
    discord_membership_verified: boolean | null
    reason_for_joining: string
  },
) {
  const discovery = application.discovery_source === 'Others'
    ? application.discovery_source_other || 'Other'
    : application.discovery_source
  const discord = application.discord_membership_verified
    ? 'Yes — verified'
    : application.already_joined_discord
      ? 'Applicant says yes — not verified'
      : 'Not joined yet'

  return `NEW NIGHTRAID APPLICATION

Application ID: ${application.application_number}
IGN: ${application.in_game_name}
Age: ${application.age_group === 'AGE_18_OR_ABOVE' ? '18 or above' : 'Under 18'}
Gender: ${application.sex}
Device: ${application.device}
Games: ${application.games.join(', ')}
Clan tag: ${application.willing_to_use_clan_tag ? 'Yes' : 'No'}
Play frequency: ${application.play_frequency}
Previous clan: ${application.previous_clan}

Reason for leaving:
${application.previous_clan_leaving_reason}

Found NightRaid through: ${discovery}
Discord: ${discord}

Reason for joining:
${application.reason_for_joining}`.slice(0, 1_980)
}

async function writeLog(input: {
  applicationId: string
  adminId: string
  psid: string
  status: 'COMPLETED' | 'FAILED'
  messageIds: string[]
  error?: string
}) {
  const { error } = await getSupabaseAdmin().from('messenger_notification_logs').insert({
    application_id: input.applicationId,
    messenger_admin_id: input.adminId,
    recipient_psid: input.psid,
    status: input.status,
    message_ids: input.messageIds,
    error_message: input.error || null,
  })
  if (error) console.error('Messenger notification log failed:', error.message)
}

export async function notifyMessengerAdmins(applicationId: string, baseUrl: string): Promise<MessengerNotificationResult> {
  const supabase = getSupabaseAdmin()
  const startedAt = new Date().toISOString()
  const { data: application, error: claimError } = await supabase
    .from('clan_applications')
    .update({
      messenger_notification_status: 'PROCESSING',
      messenger_notification_error: null,
      updated_at: startedAt,
    })
    .eq('id', applicationId)
    .in('status', ['SUBMITTED', 'PENDING_REVIEW'])
    .in('messenger_notification_status', ['NOT_STARTED', 'FAILED'])
    .select('*')
    .maybeSingle()

  if (claimError) throw new Error(`Messenger notification could not start: ${claimError.message}`)
  if (!application) throw new Error('This application is not available for a Messenger notification.')

  try {
    const [{ data: admins, error: adminError }, { data: completedLogs }] =
      await Promise.all([
        supabase.from('messenger_admins').select('*').eq('is_active', true),
        supabase
          .from('messenger_notification_logs')
          .select('recipient_psid')
          .eq('application_id', application.id)
          .eq('status', 'COMPLETED'),
      ])

    if (adminError) throw new Error(`Messenger administrators could not be loaded: ${adminError.message}`)
    if (!admins?.length) throw new Error('No active Messenger administrators are registered.')

    const alreadyDelivered = new Set((completedLogs ?? []).map((log) => log.recipient_psid))
    const recipients = admins.filter((admin) => !alreadyDelivered.has(admin.facebook_psid))
    const viewUrl = new URL('/admin/applications', `${baseUrl.replace(/\/$/, '')}/`)
    viewUrl.searchParams.set('application', application.id)
    const details = applicationText(application)

    const results = await Promise.all(
      recipients.map(async (admin) => {
        const messageIds: string[] = []
        try {
          messageIds.push(await sendMessengerText(admin.facebook_psid, details))
          const buttons: MessengerButton[] = []
          if (admin.can_approve) {
            buttons.push({
              type: 'postback',
              title: 'APPROVE',
              payload: signMessengerAction({ action: 'APPROVE', applicationId: application.id }),
            })
          }
          if (admin.can_reject) {
            buttons.push({
              type: 'postback',
              title: 'REJECT',
              payload: signMessengerAction({ action: 'REJECT_MENU', applicationId: application.id }),
            })
          }
          buttons.push({ type: 'web_url', title: 'VIEW FULL FORM', url: viewUrl.toString(), webview_height_ratio: 'full' })
          messageIds.push(
            await sendMessengerButtonTemplate(
              admin.facebook_psid,
              `${application.application_number} · ${application.in_game_name}\nAdministrator decision required.`,
              buttons,
            ),
          )
          await writeLog({
            applicationId: application.id,
            adminId: admin.id,
            psid: admin.facebook_psid,
            status: 'COMPLETED',
            messageIds,
          })
          return { ok: true as const, messageIds }
        } catch (reason) {
          const error = safeError(reason)
          await writeLog({
            applicationId: application.id,
            adminId: admin.id,
            psid: admin.facebook_psid,
            status: 'FAILED',
            messageIds,
            error,
          })
          return { ok: false as const, messageIds, error }
        }
      }),
    )

    const delivered = results.filter((result) => result.ok).length
    const failures = results.filter((result) => !result.ok)
    const messageIds = [...new Set([...application.messenger_message_ids, ...results.flatMap((result) => result.messageIds)])]
    const failed = failures.length
    const completed = failed === 0
    const error = failures.map((failure) => failure.error).join(' | ').slice(0, 500) || undefined
    const finishedAt = new Date().toISOString()
    const { error: updateError } = await supabase
      .from('clan_applications')
      .update({
        messenger_notification_status: completed ? 'COMPLETED' : 'FAILED',
        messenger_notification_error: error || null,
        messenger_notified_at: completed ? finishedAt : null,
        messenger_message_ids: messageIds,
        updated_at: finishedAt,
      })
      .eq('id', application.id)
      .eq('messenger_notification_status', 'PROCESSING')

    if (updateError) throw new Error(`Messenger notification status could not be saved: ${updateError.message}`)
    if (error) await sendBackupAlert(application.application_number, error)
    return { status: completed ? 'COMPLETED' : 'FAILED', delivered, failed, ...(error ? { error } : {}) }
  } catch (reason) {
    const error = safeError(reason)
    console.error('Messenger administrator notification failed:', error)
    await sendBackupAlert(application.application_number, error)
    const { error: failureUpdateError } = await supabase
      .from('clan_applications')
      .update({
        messenger_notification_status: 'FAILED',
        messenger_notification_error: error,
        updated_at: new Date().toISOString(),
      })
      .eq('id', application.id)
      .eq('messenger_notification_status', 'PROCESSING')
    if (failureUpdateError) console.error('Messenger notification failure status could not be saved:', failureUpdateError.message)
    return { status: 'FAILED', delivered: 0, failed: 1, error }
  }
}
