import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_STORE_PATH = path.join(process.cwd(), 'data', 'midnight-nrt.json')

export class MidnightNrtStore {
  constructor(filePath = DEFAULT_STORE_PATH) {
    this.filePath = filePath
    this.memoryNrt = {}
  }

  loadAll() {
    if (!this.filePath) return { ...this.memoryNrt }
    try {
      if (!fs.existsSync(this.filePath)) return {}
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      return typeof parsed === 'object' && parsed !== null ? parsed : {}
    } catch (reason) {
      console.error('[MidnightNrtStore] Failed to load NRT:', reason instanceof Error ? reason.message : reason)
      return {}
    }
  }

  saveAll(nrtBalances) {
    if (!this.filePath) {
      this.memoryNrt = { ...nrtBalances }
      return true
    }
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      fs.writeFileSync(this.filePath, JSON.stringify(nrtBalances, null, 2), 'utf8')
      return true
    } catch (reason) {
      console.error('[MidnightNrtStore] Failed to save NRT:', reason instanceof Error ? reason.message : reason)
      return false
    }
  }

  addNrt(userId, amount) {
    const nrtBalances = this.loadAll()
    const currentBalance = nrtBalances[userId] || 0
    nrtBalances[userId] = currentBalance + amount
    this.saveAll(nrtBalances)
    return nrtBalances[userId]
  }

  subtractNrt(userId, amount) {
    const nrtBalances = this.loadAll()
    const currentBalance = nrtBalances[userId] || 0
    nrtBalances[userId] = Math.max(0, currentBalance - amount)
    this.saveAll(nrtBalances)
    return nrtBalances[userId]
  }

  getLeaderboard() {
    const nrtBalances = this.loadAll()
    return Object.entries(nrtBalances)
      .map(([userId, balance]) => ({ userId, balance }))
      .sort((a, b) => b.balance - a.balance)
  }
}

export const midnightNrtStore = new MidnightNrtStore()
