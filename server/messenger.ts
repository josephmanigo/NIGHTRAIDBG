import { env } from './env.js'

interface MessengerResponse {
  recipient_id?: string
  message_id?: string
  error?: { message?: string }
}

export type MessengerButton =
  | { type: 'postback'; title: string; payload: string }
  | { type: 'web_url'; title: string; url: string; webview_height_ratio: 'full' }

export interface MessengerQuickReply {
  content_type: 'text'
  title: string
  payload: string
}

async function sendMessage(recipientPsid: string, message: Record<string, unknown>) {
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
        messaging_type: 'UPDATE',
        message,
      }),
      signal: AbortSignal.timeout(10_000),
    },
  )
  const payload = (await response.json().catch(() => ({}))) as MessengerResponse
  if (!response.ok || !payload.message_id) {
    throw new Error(`Meta Messenger request failed with status ${response.status}${payload.error?.message ? `: ${payload.error.message}` : '.'}`)
  }
  return payload.message_id
}

export function sendMessengerText(recipientPsid: string, text: string) {
  return sendMessage(recipientPsid, { text: text.slice(0, 2_000) })
}

export function sendMessengerButtonTemplate(recipientPsid: string, text: string, buttons: MessengerButton[]) {
  return sendMessage(recipientPsid, {
    attachment: {
      type: 'template',
      payload: {
        template_type: 'button',
        text: text.slice(0, 640),
        buttons: buttons.slice(0, 3),
      },
    },
  })
}

export function sendMessengerQuickReplies(recipientPsid: string, text: string, quickReplies: MessengerQuickReply[]) {
  return sendMessage(recipientPsid, {
    text: text.slice(0, 2_000),
    quick_replies: quickReplies.slice(0, 13),
  })
}
