import type { VercelRequest, VercelResponse } from '@vercel/node'
import { securityKey } from './request-security.js'
import { getSupabaseAdmin } from './supabase.js'

export type RateLimitResult = {
  allowed: boolean
  remaining: number
  retryAfterSeconds: number
  unavailable?: boolean
}

export async function consumeRateLimit(input: {
  scope: string
  subject: string
  request: VercelRequest
  limit: number
  windowSeconds: number
  blockSeconds: number
}): Promise<RateLimitResult> {
  const { data, error } = await getSupabaseAdmin().rpc('consume_rate_limit', {
    p_key_hash: securityKey(input.scope, input.subject, input.request),
    p_limit: input.limit,
    p_window_seconds: input.windowSeconds,
    p_block_seconds: input.blockSeconds,
  })

  if (error || !data?.[0]) {
    console.error('Rate limiter unavailable:', error?.message || 'No result returned.')
    return { allowed: false, remaining: 0, retryAfterSeconds: 60, unavailable: true }
  }

  return {
    allowed: data[0].allowed,
    remaining: data[0].remaining,
    retryAfterSeconds: data[0].retry_after_seconds,
  }
}

export function rateLimitResponse(response: VercelResponse, result: RateLimitResult) {
  response.setHeader('Cache-Control', 'no-store, max-age=0')
  response.setHeader('Retry-After', String(Math.max(1, result.retryAfterSeconds)))
  return response.status(result.unavailable ? 503 : 429).json({
    message: result.unavailable
      ? 'Security verification is temporarily unavailable. Please try again shortly.'
      : 'Too many requests. Please wait before trying again.',
    retryAfterSeconds: Math.max(1, result.retryAfterSeconds),
  })
}
