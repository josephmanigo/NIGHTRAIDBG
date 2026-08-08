import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_STORE_PATH = path.join(process.cwd(), 'data', 'winner-claims.json')

function normalizeClaim(claim) {
  return {
    sourceMessageId: String(claim.sourceMessageId || ''),
    winnerId: String(claim.winnerId || ''),
    expiresAt: Number(claim.expiresAt) || 0,
    prize: claim.prize ? String(claim.prize) : null,
    winnerCount: Math.max(0, Number(claim.winnerCount) || 0),
    status: claim.status === 'claimed' ? 'claimed' : 'open',
    claimedAt: claim.claimedAt || null,
    name: claim.name ? String(claim.name) : null,
    gcash: claim.gcash ? String(claim.gcash) : null,
    uid: claim.uid ? String(claim.uid) : null,
    createdAt: claim.createdAt || new Date().toISOString(),
    updatedAt: claim.updatedAt || new Date().toISOString(),
  }
}

export class WinnerClaimStore {
  constructor(filePath = DEFAULT_STORE_PATH) {
    this.filePath = filePath
    this.memoryClaims = []
  }

  loadAll() {
    if (!this.filePath) return this.memoryClaims.map(normalizeClaim)
    try {
      if (!fs.existsSync(this.filePath)) return []
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      return Array.isArray(parsed) ? parsed.map(normalizeClaim) : []
    } catch (reason) {
      console.error('[WinnerClaimStore] Failed to load claims:', reason instanceof Error ? reason.message : reason)
      return []
    }
  }

  saveAll(claims) {
    const normalized = claims.map(normalizeClaim)
    if (!this.filePath) {
      this.memoryClaims = normalized
      return true
    }
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      fs.writeFileSync(this.filePath, JSON.stringify(normalized, null, 2), 'utf8')
      return true
    } catch (reason) {
      console.error('[WinnerClaimStore] Failed to save claims:', reason instanceof Error ? reason.message : reason)
      return false
    }
  }

  get(sourceMessageId, winnerId) {
    return this.loadAll().find(
      (claim) => claim.sourceMessageId === String(sourceMessageId) && claim.winnerId === String(winnerId),
    ) || null
  }

  open(context) {
    const claims = this.loadAll()
    const index = claims.findIndex(
      (claim) => claim.sourceMessageId === String(context.sourceMessageId) && claim.winnerId === String(context.winnerId),
    )
    if (index >= 0 && claims[index].status === 'claimed') return claims[index]

    const record = normalizeClaim({
      ...(index >= 0 ? claims[index] : {}),
      ...context,
      status: 'open',
      updatedAt: new Date().toISOString(),
    })
    if (index >= 0) claims[index] = record
    else claims.push(record)
    this.saveAll(claims)
    return record
  }

  claim({ sourceMessageId, winnerId, now = Date.now(), ...details }) {
    const claims = this.loadAll()
    const index = claims.findIndex(
      (claim) => claim.sourceMessageId === String(sourceMessageId) && claim.winnerId === String(winnerId),
    )
    const existing = index >= 0 ? claims[index] : null
    if (existing?.status === 'claimed') return { status: 'already_claimed', claim: existing }

    const expiresAt = Number(details.expiresAt || existing?.expiresAt) || 0
    if (expiresAt > 0 && now >= expiresAt) return { status: 'expired', claim: existing }

    const record = normalizeClaim({
      ...existing,
      ...details,
      sourceMessageId,
      winnerId,
      expiresAt,
      status: 'claimed',
      claimedAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    })
    if (index >= 0) claims[index] = record
    else claims.push(record)
    this.saveAll(claims)
    return { status: 'claimed', claim: record }
  }
}
