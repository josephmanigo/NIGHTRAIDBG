/**
 * Webhook HTTP Server for Social Media Tracker.
 *
 * Provides raw-body-preserving HTTP request routing for platform webhook
 * callbacks (Twitch EventSub, YouTube WebSub, TikTok provider).
 *
 * Does NOT create its own server — exports a request handler to be
 * mounted on the existing node:http server in nickname-bot.js.
 */

const MAX_BODY_SIZE = 1_048_576 // 1 MB

/**
 * Read the raw request body as a Buffer, enforcing a size limit.
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<Buffer>}
 */
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let totalLength = 0

    req.on('data', (chunk) => {
      totalLength += chunk.length
      if (totalLength > MAX_BODY_SIZE) {
        req.destroy()
        reject(new Error('Request body too large'))
        return
      }
      chunks.push(chunk)
    })

    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * Send a JSON response.
 */
function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data)
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * Send a plain text response.
 */
function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain',
    'Content-Length': Buffer.byteLength(text),
  })
  res.end(text)
}

/**
 * Create a webhook request handler that integrates with the social tracker.
 *
 * @param {object} deps
 * @param {import('./social-tracker-service.js').SocialTrackerService} deps.socialService
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<boolean>}
 *   Returns true if the request was handled by a webhook route, false otherwise.
 */
export function createWebhookHandler(deps) {
  const { socialService } = deps

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @returns {Promise<boolean>} true if handled
   */
  async function handleRequest(req, res) {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    const pathname = url.pathname

    // ── GET /health/social-tracker ───────────────────────────
    if (pathname === '/health/social-tracker' && req.method === 'GET') {
      const health = socialService.getHealthReport()
      sendJson(res, 200, health)
      return true
    }

    // ── POST /webhooks/twitch ───────────────────────────────
    if (pathname === '/webhooks/twitch' && req.method === 'POST') {
      try {
        const rawBody = await readRawBody(req)
        await socialService.handleTwitchWebhook(req.headers, rawBody, res)
      } catch (err) {
        console.error('[WebhookServer] Twitch webhook error:', err.message)
        if (!res.headersSent) sendJson(res, 500, { error: 'Internal error' })
      }
      return true
    }

    // ── GET /webhooks/youtube (WebSub challenge verification) ──
    if (pathname === '/webhooks/youtube' && req.method === 'GET') {
      const challenge = url.searchParams.get('hub.challenge')
      const mode = url.searchParams.get('hub.mode')
      const topic = url.searchParams.get('hub.topic')
      const leaseSeconds = url.searchParams.get('hub.lease_seconds')

      if (challenge && mode === 'subscribe') {
        console.log(`[WebhookServer] YouTube WebSub verification: topic=${topic}, lease=${leaseSeconds}s`)
        if (topic && leaseSeconds) {
          socialService.handleYouTubeSubscriptionConfirmed(topic, Number(leaseSeconds))
        }
        sendText(res, 200, challenge)
      } else if (challenge && mode === 'unsubscribe') {
        console.log(`[WebhookServer] YouTube WebSub unsubscribe confirmed: topic=${topic}`)
        sendText(res, 200, challenge)
      } else {
        sendText(res, 400, 'Missing hub.challenge')
      }
      return true
    }

    // ── POST /webhooks/youtube (Atom XML push notification) ──
    if (pathname === '/webhooks/youtube' && req.method === 'POST') {
      try {
        const rawBody = await readRawBody(req)
        await socialService.handleYouTubeWebhook(rawBody)
        sendText(res, 200, 'OK')
      } catch (err) {
        console.error('[WebhookServer] YouTube webhook error:', err.message)
        if (!res.headersSent) sendJson(res, 500, { error: 'Internal error' })
      }
      return true
    }

    // ── POST /webhooks/tiktok ───────────────────────────────
    if (pathname === '/webhooks/tiktok' && req.method === 'POST') {
      try {
        const rawBody = await readRawBody(req)
        await socialService.handleTikTokWebhook(req.headers, rawBody, res)
      } catch (err) {
        console.error('[WebhookServer] TikTok webhook error:', err.message)
        if (!res.headersSent) sendJson(res, 500, { error: 'Internal error' })
      }
      return true
    }

    return false // Not a webhook route
  }

  return handleRequest
}
