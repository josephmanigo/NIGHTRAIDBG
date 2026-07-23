import { randomBytes, timingSafeEqual } from 'node:crypto'
import { parseCookie, stringifySetCookie } from 'cookie'
import { SignJWT, jwtVerify } from 'jose'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { env, isProduction } from './env.js'

const SESSION_COOKIE = 'nr_session'
const OAUTH_STATE_COOKIE = 'nr_oauth_state'
const RETURN_TO_COOKIE = 'nr_return_to'
const SESSION_MAX_AGE = 60 * 60 * 24 * 7
const SESSION_ISSUER = 'nightraid'
const SESSION_AUDIENCE = 'nightraid-web'

export interface SessionUser {
  discordUserId: string
  discordUsername: string
  discordAvatar: string | null
}

function signingKey() {
  return new TextEncoder().encode(env.sessionSecret())
}

function cookies(request: VercelRequest) {
  return parseCookie(request.headers.cookie ?? '')
}

function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    secure: isProduction(),
    sameSite: 'lax' as const,
    path: '/',
    maxAge,
  }
}

function appendCookie(response: VercelResponse, value: string) {
  const current = response.getHeader('Set-Cookie')
  const values = Array.isArray(current) ? current.map(String) : current ? [String(current)] : []
  response.setHeader('Set-Cookie', [...values, value])
}

export function createOAuthState() {
  return randomBytes(32).toString('base64url')
}

export function setOAuthCookies(response: VercelResponse, state: string, returnTo: string) {
  appendCookie(response, stringifySetCookie({ name: OAUTH_STATE_COOKIE, value: state, ...cookieOptions(60 * 10) }))
  appendCookie(response, stringifySetCookie({ name: RETURN_TO_COOKIE, value: returnTo, ...cookieOptions(60 * 10) }))
}

export function readOAuthState(request: VercelRequest) {
  return cookies(request)[OAUTH_STATE_COOKIE]
}

export function readReturnTo(request: VercelRequest) {
  return cookies(request)[RETURN_TO_COOKIE]
}

export function matchesOAuthState(expected: string | undefined, actual: string | undefined) {
  if (!expected || !actual) return false
  const left = Buffer.from(expected)
  const right = Buffer.from(actual)
  return left.length === right.length && timingSafeEqual(left, right)
}

export function clearOAuthCookies(response: VercelResponse) {
  appendCookie(response, stringifySetCookie({ name: OAUTH_STATE_COOKIE, value: '', ...cookieOptions(0) }))
  appendCookie(response, stringifySetCookie({ name: RETURN_TO_COOKIE, value: '', ...cookieOptions(0) }))
}

export async function createSessionToken(user: SessionUser) {
  return new SignJWT({
    username: user.discordUsername,
    avatar: user.discordAvatar,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.discordUserId)
    .setIssuer(SESSION_ISSUER)
    .setAudience(SESSION_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(signingKey())
}

export function setSessionCookie(response: VercelResponse, token: string) {
  appendCookie(response, stringifySetCookie({ name: SESSION_COOKIE, value: token, ...cookieOptions(SESSION_MAX_AGE) }))
}

export async function getSession(request: VercelRequest): Promise<SessionUser | null> {
  const token = cookies(request)[SESSION_COOKIE]
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, signingKey(), {
      algorithms: ['HS256'],
      issuer: SESSION_ISSUER,
      audience: SESSION_AUDIENCE,
    })
    if (!payload.sub || typeof payload.username !== 'string') return null
    return {
      discordUserId: payload.sub,
      discordUsername: payload.username,
      discordAvatar: typeof payload.avatar === 'string' ? payload.avatar : null,
    }
  } catch {
    return null
  }
}

export function clearSessionCookie(response: VercelResponse) {
  appendCookie(response, stringifySetCookie({ name: SESSION_COOKIE, value: '', ...cookieOptions(0) }))
}
