import type { VercelRequest, VercelResponse } from '@vercel/node'
import { env } from './env.js'

export function singleQueryValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value
}

export function noStore(response: VercelResponse) {
  response.setHeader('Cache-Control', 'no-store, max-age=0')
}

export function methodNotAllowed(response: VercelResponse, allowed: string[]) {
  response.setHeader('Allow', allowed.join(', '))
  return response.status(405).json({ message: 'Method not allowed.' })
}

export function getRequestOrigin(request: VercelRequest) {
  if (env.appUrl()) return env.appUrl()!.replace(/\/$/, '')

  const forwardedHost = singleQueryValue(request.headers['x-forwarded-host'])
  const host = forwardedHost || singleQueryValue(request.headers.host) || 'localhost:3000'
  const forwardedProto = singleQueryValue(request.headers['x-forwarded-proto'])
  const protocol = forwardedProto || (host.startsWith('localhost') ? 'http' : 'https')
  return `${protocol}://${host}`
}

export function appUrl(request: VercelRequest, path: string) {
  return new URL(path, `${getRequestOrigin(request)}/`).toString()
}

export function safeReturnTo(value: string | undefined) {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/apply'
  return value
}

export function hasTrustedOrigin(request: VercelRequest) {
  const fetchSite = singleQueryValue(request.headers['sec-fetch-site'])
  if (fetchSite === 'cross-site') return false
  const origin = singleQueryValue(request.headers.origin)
  if (!origin) return true
  return origin === getRequestOrigin(request)
}

export function requestBody(request: VercelRequest): unknown {
  if (typeof request.body !== 'string') return request.body
  try {
    return JSON.parse(request.body) as unknown
  } catch {
    return null
  }
}
