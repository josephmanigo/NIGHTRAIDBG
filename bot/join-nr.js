/*
 * Auto-reply listener for NIGHTRAID join/application questions.
 *
 * Detects questions asking how to join or apply to NIGHTRAID (in Tagalog/English)
 * across all server channels (including ticket channels) and replies with
 * the fetched official application message 1529820235253809234.
 */

export const JOIN_NR_MESSAGE_ID = '1529820235253809234'
export const JOIN_NR_CHANNEL_ID = '1239020074908520478'

export function containsJoinNRKeyword(content) {
  if (!content || typeof content !== 'string') return false

  const patterns = [
    /p[a-z]*no?\s+(?:mag\s*)?sumali/i,
    /p[a-z]*no?\s+(?:mag\s*)?apply/i,
    /p[a-z]*no?\s+(?:mag\s*)?pumasok/i,
    /how\s+to\s+join/i,
    /how\s+to\s+app(?:ly|y)/i,
    /sumali\s+sa\s+(?:clan\s+ng\s+)?n(?:ightraid|r)/i,
    /apply\s+sa\s+n(?:ightraid|r)/i,
    /join\s+n(?:ightraid|r|clan)/i,
    /pa?no?\s+po\s+sumali/i,
  ]

  return patterns.some((pattern) => pattern.test(content))
}

export function formatJoinNRReply(guildId, channelId = JOIN_NR_CHANNEL_ID, messageId = JOIN_NR_MESSAGE_ID) {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`
}

export async function fetchAndFormatJoinNRReply(
  client,
  guildId,
  channelId = JOIN_NR_CHANNEL_ID,
  messageId = JOIN_NR_MESSAGE_ID
) {
  if (client && client.channels) {
    try {
      const channel = await client.channels.fetch(channelId).catch(() => null)
      if (channel && channel.isTextBased?.()) {
        const fetchedMsg = await channel.messages.fetch(messageId).catch(() => null)
        if (fetchedMsg) {
          const payload = {}

          if (fetchedMsg.content) {
            payload.content = fetchedMsg.content
          }

          if (fetchedMsg.embeds && fetchedMsg.embeds.length > 0) {
            payload.embeds = fetchedMsg.embeds.map((e) => (typeof e.toJSON === 'function' ? e.toJSON() : e))
          }

          if (fetchedMsg.attachments && fetchedMsg.attachments.size > 0) {
            payload.files = [...fetchedMsg.attachments.values()].map((a) => a.url || a)
          }

          if (fetchedMsg.components && fetchedMsg.components.length > 0) {
            payload.components = fetchedMsg.components.map((c) => (typeof c.toJSON === 'function' ? c.toJSON() : c))
          }

          if (Object.keys(payload).length > 0) {
            return payload
          }
        }
      }
    } catch (err) {
      console.error('[JoinNR] Could not fetch target message:', err.message)
    }
  }

  return { content: formatJoinNRReply(guildId, channelId, messageId) }
}
