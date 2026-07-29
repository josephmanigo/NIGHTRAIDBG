export const NIGHTRAID_SERVER_INVITE_URL = 'https://discord.gg/ufwJ7wWu9H'

export function containsLinkKeyword(content) {
  return /\blink\b/i.test(content ?? '')
}
