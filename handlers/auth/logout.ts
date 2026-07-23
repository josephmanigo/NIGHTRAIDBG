// Routed through the consolidated Vercel API function.
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { hasTrustedOrigin, methodNotAllowed } from '../../server/http.js'
import { clearSessionCookie } from '../../server/session.js'

export default function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'POST') return methodNotAllowed(response, ['POST'])
  if (!hasTrustedOrigin(request)) return response.status(403).json({ message: 'Untrusted request origin.' })
  clearSessionCookie(response)
  return response.status(200).json({ ok: true })
}
