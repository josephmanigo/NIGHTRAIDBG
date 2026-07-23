import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { env } from './env.js'

export const rejectionReasons = {
  RANK_REQUIREMENT: 'Rank requirement',
  INCOMPLETE_INFORMATION: 'Incomplete information',
  SCHEDULE_CONFLICT: 'Schedule conflict',
  BEHAVIOR_CONCERN: 'Behavior concern',
  DUPLICATE_APPLICATION: 'Duplicate application',
  OTHER: 'Other',
} as const

const actionSchema = z
  .object({
    version: z.literal(1),
    action: z.enum(['APPROVE', 'REJECT_MENU', 'REJECT_REASON', 'REJECT_CONFIRM', 'REJECT_CANCEL']),
    applicationId: z.string().uuid(),
    reason: z.enum(Object.keys(rejectionReasons) as [keyof typeof rejectionReasons, ...(keyof typeof rejectionReasons)[]]).optional(),
    expiresAt: z.number().int().positive(),
  })
  .strict()

export type MessengerAction = z.infer<typeof actionSchema>

function hmac(value: string, secret: string) {
  return createHmac('sha256', secret).update(value).digest('base64url')
}

export function signMessengerAction(
  action: Omit<MessengerAction, 'version' | 'expiresAt'>,
  lifetimeSeconds = 7 * 24 * 60 * 60,
) {
  const encoded = Buffer.from(
    JSON.stringify({ ...action, version: 1, expiresAt: Math.floor(Date.now() / 1000) + lifetimeSeconds }),
  ).toString('base64url')
  return `NR1.${encoded}.${hmac(encoded, env.applicationSigningSecret())}`
}

export function verifyMessengerAction(payload: string) {
  const [prefix, encoded, signature, extra] = payload.split('.')
  if (prefix !== 'NR1' || !encoded || !signature || extra) throw new Error('Invalid Messenger action payload.')
  const expected = hmac(encoded, env.applicationSigningSecret())
  const actualBuffer = Buffer.from(signature)
  const expectedBuffer = Buffer.from(expected)
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    throw new Error('Invalid Messenger action signature.')
  }

  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown
  } catch {
    throw new Error('Invalid Messenger action encoding.')
  }
  const result = actionSchema.safeParse(decoded)
  if (!result.success) throw new Error('Invalid Messenger action data.')
  if (result.data.expiresAt < Math.floor(Date.now() / 1000)) throw new Error('This Messenger action has expired.')
  return result.data
}

export function verifyMetaWebhookSignature(rawBody: Buffer, header: string | undefined) {
  if (!header?.startsWith('sha256=')) return false
  const provided = header.slice('sha256='.length)
  const expected = createHmac('sha256', env.metaAppSecret()).update(rawBody).digest('hex')
  const providedBuffer = Buffer.from(provided)
  const expectedBuffer = Buffer.from(expected)
  return providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer)
}
