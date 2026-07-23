import type { VercelRequest, VercelResponse } from '@vercel/node'
import approveApplication from '../handlers/admin/applications/[id]/approve.js'
import rejectApplication from '../handlers/admin/applications/[id]/reject.js'
import retryDiscord from '../handlers/admin/applications/[id]/retry-discord.js'
import retryEvaluation from '../handlers/admin/applications/[id]/retry-evaluation.js'
import retryMessenger from '../handlers/admin/applications/[id]/retry-messenger.js'
import excelStatus from '../handlers/admin/applications/excel-status.js'
import exportApplications from '../handlers/admin/applications/export.js'
import exportApplicationsWorkbook from '../handlers/admin/applications/export.xlsx.js'
import listApplications from '../handlers/admin/applications/index.js'
import syncExcel from '../handlers/admin/applications/sync-excel.js'
import deactivateBan from '../handlers/admin/bans/[id]/deactivate.js'
import createBan from '../handlers/admin/bans/index.js'
import security from '../handlers/admin/security.js'
import discordCallback from '../handlers/auth/discord/callback.js'
import discordLogin from '../handlers/auth/discord/index.js'
import logout from '../handlers/auth/logout.js'
import session from '../handlers/auth/session.js'
import submitApplication from '../handlers/clan-applications/index.js'
import myApplication from '../handlers/clan-applications/me.js'
import messengerWebhook from '../handlers/webhooks/messenger.js'
import { singleQueryValue } from '../server/http.js'

type Handler = (request: VercelRequest, response: VercelResponse) => unknown | Promise<unknown>

const routes: Record<string, Handler> = {
  'admin/applications': listApplications,
  'admin/applications/excel-status': excelStatus,
  'admin/applications/export': exportApplications,
  'admin/applications/export.xlsx': exportApplicationsWorkbook,
  'admin/applications/sync-excel': syncExcel,
  'admin/bans': createBan,
  'admin/security': security,
  'auth/discord': discordLogin,
  'auth/discord/callback': discordCallback,
  'auth/logout': logout,
  'auth/session': session,
  'clan-applications': submitApplication,
  'clan-applications/me': myApplication,
  'webhooks/messenger': messengerWebhook,
}

const applicationActions: Record<string, Handler> = {
  approve: approveApplication,
  reject: rejectApplication,
  'retry-discord': retryDiscord,
  'retry-evaluation': retryEvaluation,
  'retry-messenger': retryMessenger,
}

function routeValue(request: VercelRequest) {
  return (singleQueryValue(request.query._route) ?? '').replace(/^\/+|\/+$/g, '')
}

function decodeSegment(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    return ''
  }
}

function resolveHandler(request: VercelRequest, route: string): Handler | null {
  const exact = routes[route]
  if (exact) return exact

  const applicationMatch = /^admin\/applications\/([^/]+)\/([^/]+)$/.exec(route)
  if (applicationMatch) {
    const id = decodeSegment(applicationMatch[1])
    const action = applicationActions[applicationMatch[2]]
    if (!id || !action) return null
    request.query.id = id
    return action
  }

  const banMatch = /^admin\/bans\/([^/]+)\/deactivate$/.exec(route)
  if (banMatch) {
    const id = decodeSegment(banMatch[1])
    if (!id) return null
    request.query.id = id
    return deactivateBan
  }

  return null
}

async function parseBody(request: VercelRequest, route: string) {
  if (route === 'webhooks/messenger' || request.method === 'GET' || request.method === 'HEAD') return
  if (request.body !== undefined && request.body !== null) return

  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += buffer.length
    if (length > 2_000_000) throw new Error('REQUEST_BODY_TOO_LARGE')
    chunks.push(buffer)
  }

  const value = Buffer.concat(chunks).toString('utf8')
  if (!value) {
    request.body = null
    return
  }
  if (singleQueryValue(request.headers['content-type'])?.toLowerCase().includes('application/json')) {
    try {
      request.body = JSON.parse(value) as unknown
      return
    } catch {
      request.body = null
      return
    }
  }
  request.body = value
}

export default async function handler(request: VercelRequest, response: VercelResponse) {
  const route = routeValue(request)
  const target = resolveHandler(request, route)
  if (!target) return response.status(404).json({ message: 'API route not found.' })

  try {
    await parseBody(request, route)
  } catch (reason) {
    if (reason instanceof Error && reason.message === 'REQUEST_BODY_TOO_LARGE') {
      return response.status(413).json({ message: 'Request body is too large.' })
    }
    return response.status(400).json({ message: 'Invalid request body.' })
  }

  return target(request, response)
}

export const config = { api: { bodyParser: false }, maxDuration: 60 }
