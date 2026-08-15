import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_STORE_PATH = path.join(process.cwd(), 'data', 'midnight-tokens.json')

export class MidnightTokenStore {
  constructor(filePath = DEFAULT_STORE_PATH) {
    this.filePath = filePath
    this.memoryTokens = {}
  }

  loadAll() {
    if (!this.filePath) return { ...this.memoryTokens }
    try {
      if (!fs.existsSync(this.filePath)) return {}
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      return typeof parsed === 'object' && parsed !== null ? parsed : {}
    } catch (reason) {
      console.error('[MidnightTokenStore] Failed to load tokens:', reason instanceof Error ? reason.message : reason)
      return {}
    }
  }

  saveAll(tokens) {
    if (!this.filePath) {
      this.memoryTokens = { ...tokens }
      return true
    }
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      fs.writeFileSync(this.filePath, JSON.stringify(tokens, null, 2), 'utf8')
      return true
    } catch (reason) {
      console.error('[MidnightTokenStore] Failed to save tokens:', reason instanceof Error ? reason.message : reason)
      return false
    }
  }

  addToken(userId, amount) {
    const tokens = this.loadAll()
    const currentBalance = tokens[userId] || 0
    tokens[userId] = currentBalance + amount
    this.saveAll(tokens)
    return tokens[userId]
  }

  getLeaderboard() {
    const tokens = this.loadAll()
    return Object.entries(tokens)
      .map(([userId, balance]) => ({ userId, balance }))
      .sort((a, b) => b.balance - a.balance)
  }
}

export const midnightTokenStore = new MidnightTokenStore()
