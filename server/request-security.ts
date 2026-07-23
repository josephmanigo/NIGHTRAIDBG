import { createHmac } from 'node:crypto'
import type { VercelRequest } from '@vercel/node'
import { env } from './env.js'
import { singleQueryValue } from './http.js'

function hmac(value: string) {
  return createHmac('sha256', env.applicationSigningSecret()).update(value).digest('hex')
}
export function requestIpAddress(request: VercelRequest) {
  const forwarded = singleQueryValue(request.headers['x-forwarded-for'])
  const candidate = forwarded?.split(',')[0]?.trim() || request.socket?.remoteAddress?.trim()
  return candidate || 'unknown'
}

export function requestFingerprint(request: VercelRequest) {
  const userAgent = singleQueryValue(request.headers['user-agent'])?.slice(0, 500) || 'unknown'
  return {
    ipAddressHash: hmac(`ip:${requestIpAddress(request)}`),
    userAgentHash: hmac(`ua:${userAgent}`),
    requestId:
      singleQueryValue(request.headers['x-vercel-id'])?.slice(0, 200) ||
      singleQueryValue(request.headers['x-request-id'])?.slice(0, 200) ||
      null,
  }
}

export function securityKey(scope: string, subject: string, request?: VercelRequest) {
  const network = request ? requestIpAddress(request) : 'no-network'
  return hmac(`rate:${scope}:${subject}:${network}`)
}
