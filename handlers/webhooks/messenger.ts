// Routed through the consolidated Vercel API function.
import { createHash } from 'node:crypto'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { approveApplication, DecisionConflictError, rejectApplication } from '../../server/application-decisions.js'
import type { Json } from '../../server/database.types.js'
import { env } from '../../server/env.js'
import { methodNotAllowed, singleQueryValue } from '../../server/http.js'
import {
  sendMessengerButtonTemplate,
  sendMessengerQuickReplies,
  sendMessengerText,
  type MessengerQuickReply,
} from '../../server/messenger.js'
import {
  rejectionReasons,
  signMessengerAction,
  verifyMessengerAction,
  verifyMetaWebhookSignature,
} from '../../server/messenger-security.js'
import { getSupabaseAdmin } from '../../server/supabase.js'

interface MetaMessagingEvent {
  sender?: { id?: string }
  recipient?: { id?: string }
  timestamp?: number
  message?: { mid?: string; text?: string; quick_reply?: { payload?: string } }
  postback?: { mid?: string; payload?: string; title?: string }
}

interface MetaWebhookBody {
  object?: string
  entry?: Array<{ id?: string; time?: number; messaging?: MetaMessagingEvent[] }>
}

async function rawBody(request: VercelRequest) {
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += buffer.length
    if (length > 1_000_000) throw new Error('Messenger webhook payload is too large.')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function webhookEventId(event: MetaMessagingEvent) {
  const providerId = event.message?.mid || event.postback?.mid
  if (providerId) return providerId
  return createHash('sha256')
    .update(`${event.sender?.id || ''}:${event.timestamp || ''}:${JSON.stringify(event)}`)
    .digest('hex')
}

function actionPayload(event: MetaMessagingEvent) {
  return event.postback?.payload || event.message?.quick_reply?.payload
}

async function updateWebhookEvent(id: string, status: 'COMPLETED' | 'FAILED' | 'IGNORED', error?: string) {
  const { error: updateError } = await getSupabaseAdmin()
    .from('messenger_webhook_events')
    .update({
      processing_status: status,
      error_message: error || null,
      processed_at: new Date().toISOString(),
    })
    .eq('id', id)
  if (updateError) console.error('Messenger webhook event status failed:', updateError.message)
}

async function bestEffortMessengerReply(senderPsid: string, text: string) {
  try {
    await sendMessengerText(senderPsid, text)
  } catch (reason) {
    console.error('Messenger action reply failed:', reason instanceof Error ? reason.message : 'Unknown reply error')
  }
}

async function processEvent(event: MetaMessagingEvent) {
  const senderPsid = event.sender?.id
  if (!senderPsid) return
  const payload = actionPayload(event)
  const eventType = payload ? (event.postback ? 'POSTBACK' : 'QUICK_REPLY') : 'MESSAGE'
  const supabase = getSupabaseAdmin()
  const { data: savedEvent, error: insertError } = await supabase
    .from('messenger_webhook_events')
    .insert({
      external_event_id: webhookEventId(event),
      sender_psid: senderPsid,
      event_type: eventType,
      payload: JSON.parse(JSON.stringify(event)) as Json,
      processing_status: 'PROCESSING',
      error_message: null,
    })
    .select('id')
    .single()

  if (insertError?.code === '23505') return
  if (insertError || !savedEvent) throw new Error('Messenger webhook event could not be recorded.')

  if (!payload) {
    await updateWebhookEvent(savedEvent.id, 'IGNORED')
    return
  }

  try {
    const action = verifyMessengerAction(payload)
    const { data: admin, error: adminError } = await supabase
      .from('messenger_admins')
      .select('*')
      .eq('facebook_psid', senderPsid)
      .eq('is_active', true)
      .maybeSingle()
    if (adminError) throw new Error('Messenger administrator access could not be verified.')
    if (!admin) {
      await updateWebhookEvent(savedEvent.id, 'IGNORED', 'Unauthorized Messenger sender.')
      return
    }

    if (action.action === 'APPROVE') {
      if (!admin.can_approve) throw new Error('This Messenger administrator cannot approve applications.')
      const result = await approveApplication({
        applicationId: action.applicationId,
        source: 'MESSENGER',
        decidedBy: senderPsid,
      })
      await sendMessengerText(
        senderPsid,
        result.onboarding.status === 'COMPLETED'
          ? `Approved ${result.application.application_number}. Discord onboarding completed.${result.applicantNotification === 'COMPLETED' ? ' The applicant was notified through Discord.' : result.applicantNotification === 'PORTAL_ONLY' ? ' The applicant is not in the Discord server, so the acceptance is visible in the status portal.' : ' The applicant DM failed unexpectedly, but the acceptance is visible in the status portal.'}`
          : `Approved ${result.application.application_number}, but Discord onboarding needs a retry in the admin portal.${result.applicantNotification === 'COMPLETED' ? ' The applicant was notified through Discord.' : result.applicantNotification === 'PORTAL_ONLY' ? ' The applicant is not in the Discord server, so the acceptance is visible in the status portal.' : ' The applicant DM failed unexpectedly, but the acceptance is visible in the status portal.'}`,
      )
    } else if (action.action === 'REJECT_MENU') {
      if (!admin.can_reject) throw new Error('This Messenger administrator cannot reject applications.')
      const quickReplies: MessengerQuickReply[] = Object.entries(rejectionReasons).map(([reason, label]) => ({
        content_type: 'text',
        title: label,
        payload: signMessengerAction({
          action: 'REJECT_REASON',
          applicationId: action.applicationId,
          reason: reason as keyof typeof rejectionReasons,
        }),
      }))
      await sendMessengerQuickReplies(senderPsid, 'Select the rejection reason:', quickReplies)
    } else if (action.action === 'REJECT_REASON') {
      if (!admin.can_reject || !action.reason) throw new Error('This rejection action is not permitted.')
      await sendMessengerButtonTemplate(
        senderPsid,
        `Reject this application?\nReason: ${rejectionReasons[action.reason]}`,
        [
          {
            type: 'postback',
            title: 'CONFIRM REJECTION',
            payload: signMessengerAction({
              action: 'REJECT_CONFIRM',
              applicationId: action.applicationId,
              reason: action.reason,
            }),
          },
          {
            type: 'postback',
            title: 'CANCEL',
            payload: signMessengerAction({ action: 'REJECT_CANCEL', applicationId: action.applicationId }),
          },
        ],
      )
    } else if (action.action === 'REJECT_CONFIRM') {
      if (!admin.can_reject || !action.reason) throw new Error('This rejection action is not permitted.')
      const result = await rejectApplication({
        applicationId: action.applicationId,
        reason: rejectionReasons[action.reason],
        source: 'MESSENGER',
        decidedBy: senderPsid,
      })
      await sendMessengerText(
        senderPsid,
        result.applicantNotification === 'COMPLETED'
          ? `Rejected ${result.application.application_number}. The applicant was notified through Discord.`
          : result.applicantNotification === 'PORTAL_ONLY'
            ? `Rejected ${result.application.application_number}. The applicant is not in the Discord server, so the decision is available in the status portal.`
            : `Rejected ${result.application.application_number}. The Discord DM failed unexpectedly, but the decision is visible in the applicant portal.`,
      )
    } else if (action.action === 'REJECT_CANCEL') {
      if (!admin.can_reject) throw new Error('This rejection action is not permitted.')
      await sendMessengerText(senderPsid, 'Rejection cancelled. No application decision was changed.')
    }

    await updateWebhookEvent(savedEvent.id, 'COMPLETED')
  } catch (reason) {
    const message = reason instanceof Error ? reason.message.slice(0, 500) : 'Messenger action failed.'
    await updateWebhookEvent(savedEvent.id, 'FAILED', message)
    if (reason instanceof DecisionConflictError) {
      await bestEffortMessengerReply(senderPsid, 'This application is no longer pending. Open the admin portal for its current status.')
    } else {
      console.error('Messenger action failed:', message)
      await bestEffortMessengerReply(senderPsid, 'The action could not be completed safely. Use the NIGHTRAID admin portal or try again.')
    }
  }
}

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method === 'GET') {
    const mode = singleQueryValue(request.query['hub.mode'])
    const token = singleQueryValue(request.query['hub.verify_token'])
    const challenge = singleQueryValue(request.query['hub.challenge'])
    if (mode === 'subscribe' && token === env.metaVerifyToken() && challenge) {
      return response.status(200).send(challenge)
    }
    return response.status(403).send('Webhook verification failed.')
  }

  if (request.method !== 'POST') return methodNotAllowed(response, ['GET', 'POST'])

  let body: Buffer
  try {
    body = await rawBody(request)
  } catch {
    return response.status(413).json({ message: 'Webhook payload is too large.' })
  }
  const signature = singleQueryValue(request.headers['x-hub-signature-256'])
  if (!verifyMetaWebhookSignature(body, signature)) {
    return response.status(401).json({ message: 'Invalid webhook signature.' })
  }

  let webhook: MetaWebhookBody
  try {
    webhook = JSON.parse(body.toString('utf8')) as MetaWebhookBody
  } catch {
    return response.status(400).json({ message: 'Invalid webhook JSON.' })
  }
  if (webhook.object !== 'page' || !Array.isArray(webhook.entry)) return response.status(200).json({ received: true })

  for (const entry of webhook.entry) {
    if (entry.id !== env.metaPageId() || !Array.isArray(entry.messaging)) continue
    for (const event of entry.messaging) await processEvent(event)
  }
  return response.status(200).json({ received: true })
}

export const config = { api: { bodyParser: false }, maxDuration: 60 }
