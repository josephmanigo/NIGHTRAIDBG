import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_STORE_PATH = path.join(process.cwd(), 'data', 'winner-claims.json')

function claimStoreError(action, reason) {
  const error = new Error(`Winner claim storage ${action} failed.`, { cause: reason })
  error.code = 'WINNER_CLAIM_STORE_FAILED'
  return error
}

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
      if (!Array.isArray(parsed)) {
        throw new Error('Winner claim data must be a JSON array.')
      }
      return parsed.map(normalizeClaim)
    } catch (reason) {
      console.error('[WinnerClaimStore] Failed to load claims:', reason instanceof Error ? reason.message : reason)
      throw claimStoreError('read', reason)
    }
  }

  saveAll(claims) {
    const normalized = claims.map(normalizeClaim)
    if (!this.filePath) {
      this.memoryClaims = normalized
      return true
    }
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      fs.writeFileSync(temporaryPath, JSON.stringify(normalized, null, 2), 'utf8')
      fs.renameSync(temporaryPath, this.filePath)
      return true
    } catch (reason) {
      try {
        if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath)
      } catch {}
      console.error('[WinnerClaimStore] Failed to save claims:', reason instanceof Error ? reason.message : reason)
      throw claimStoreError('write', reason)
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
