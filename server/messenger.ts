import { env } from './env.js'

interface MessengerResponse {
  recipient_id?: string
  message_id?: string
  error?: { message?: string; code?: number; error_subcode?: number }
}

export type MessengerButton =
  | { type: 'postback'; title: string; payload: string }
  | { type: 'web_url'; title: string; url: string; webview_height_ratio: 'full' }

export interface MessengerQuickReply {
  content_type: 'text'
  title: string
  payload: string
}

export interface MessengerSendOptions {
  /* Meta only accepts an unprompted message within 24 hours of the
   * recipient's last interaction with the page. A message tag reopens that
   * window for the narrow purposes Meta allows, so proactive notifications
   * pass one and conversation replies do not. */
  tag?: string
}

/* "(#10) This message is sent outside of allowed window." */
const OUTSIDE_WINDOW_CODE = 10
const OUTSIDE_WINDOW_SUBCODE = 2_018_278

interface SendAttempt {
  messageId?: string
  status: number
  error?: string
  outsideWindow: boolean
}

async function postMessage(
  recipientPsid: string,
  message: Record<string, unknown>,
  tag?: string,
): Promise<SendAttempt> {
  const response = await fetch(
    `https://graph.facebook.com/${encodeURIComponent(env.metaGraphApiVersion())}/${encodeURIComponent(env.metaPageId())}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.metaPageAccessToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        recipient: { id: recipientPsid },
        messaging_type: tag ? 'MESSAGE_TAG' : 'UPDATE',
        ...(tag ? { tag } : {}),
        message,
      }),
      signal: AbortSignal.timeout(10_000),
    },
  )
  const payload = (await response.json().catch(() => ({}))) as MessengerResponse
  if (response.ok && payload.message_id) {
    return { messageId: payload.message_id, status: response.status, outsideWindow: false }
  }
  const error = payload.error?.message
  return {
    status: response.status,
    error,
    outsideWindow:
      payload.error?.error_subcode === OUTSIDE_WINDOW_SUBCODE ||
      (payload.error?.code === OUTSIDE_WINDOW_CODE && /outside of allowed window/i.test(error || '')),
  }
}

function failure(attempt: SendAttempt, suffix = '') {
  return new Error(
    `Meta Messenger request failed with status ${attempt.status}${attempt.error ? `: ${attempt.error}` : '.'}${suffix}`,
  )
}

async function sendMessage(
  recipientPsid: string,
  message: Record<string, unknown>,
  options: MessengerSendOptions = {},
) {
  const attempt = await postMessage(recipientPsid, message)
  if (attempt.messageId) return attempt.messageId
  if (!options.tag || !attempt.outsideWindow) throw failure(attempt)

  const tagged = await postMessage(recipientPsid, message, options.tag)
  if (tagged.messageId) return tagged.messageId
  throw failure(
    tagged,
    ` The 24-hour Messenger window is closed and the ${options.tag} message tag was rejected, so this administrator has to send the NIGHTRAID page a message before Messenger delivery works again.`,
  )
}

export function sendMessengerText(recipientPsid: string, text: string, options?: MessengerSendOptions) {
  return sendMessage(recipientPsid, { text: text.slice(0, 2_000) }, options)
}

export function sendMessengerButtonTemplate(
  recipientPsid: string,
  text: string,
  buttons: MessengerButton[],
  options?: MessengerSendOptions,
) {
  return sendMessage(
    recipientPsid,
    {
      attachment: {
        type: 'template',
        payload: {
          template_type: 'button',
          text: text.slice(0, 640),
          buttons: buttons.slice(0, 3),
        },
      },
    },
    options,
  )
}

export function sendMessengerQuickReplies(recipientPsid: string, text: string, quickReplies: MessengerQuickReply[]) {
  return sendMessage(recipientPsid, {
    text: text.slice(0, 2_000),
    quick_replies: quickReplies.slice(0, 13),
  })
}
