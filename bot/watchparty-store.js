import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_STORE_PATH = path.join(process.cwd(), 'data', 'watch-parties.json')

function normalizeParty(party) {
  return {
    id: String(party.id),
    guildId: String(party.guildId || ''),
    channelId: String(party.channelId || ''),
    messageId: party.messageId ? String(party.messageId) : null,
    hostId: String(party.hostId || ''),
    title: String(party.title || 'Movie Watch Party').slice(0, 256),
    url: String(party.url || 'https://movibox.net/'),
    sourceType: party.sourceType === 'url' ? 'url' : 'search',
    scheduledFor: party.scheduledFor || null,
    participantIds: [...new Set((party.participantIds || []).map(String))],
    status: party.status === 'started' ? 'started' : 'open',
    reminderSentAt: party.reminderSentAt || null,
    startedAt: party.startedAt || null,
    createdAt: party.createdAt || new Date().toISOString(),
    updatedAt: party.updatedAt || new Date().toISOString(),
  }
}

export class WatchpartyStore {
  constructor(filePath = DEFAULT_STORE_PATH) {
    this.filePath = filePath
    this.memoryRecords = []
  }

  loadAll() {
    if (!this.filePath) return this.memoryRecords.map(normalizeParty)
    try {
      if (!fs.existsSync(this.filePath)) return []
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      return Array.isArray(parsed) ? parsed.map(normalizeParty) : []
    } catch (reason) {
      console.error('[WatchpartyStore] Failed to load parties:', reason instanceof Error ? reason.message : reason)
      return []
    }
  }

  saveAll(parties) {
    const normalized = parties.map(normalizeParty)
    if (!this.filePath) {
      this.memoryRecords = normalized
      return true
    }
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      fs.writeFileSync(this.filePath, JSON.stringify(normalized, null, 2), 'utf8')
      return true
    } catch (reason) {
      console.error('[WatchpartyStore] Failed to save parties:', reason instanceof Error ? reason.message : reason)
      return false
    }
  }

  get(id) {
    return this.loadAll().find((party) => party.id === id) || null
  }

  create(party) {
    const parties = this.loadAll()
    const record = normalizeParty(party)
    parties.push(record)
    this.saveAll(parties)
    return record
  }

  update(id, updater) {
    const parties = this.loadAll()
    const index = parties.findIndex((party) => party.id === id)
    if (index < 0) return null
    const current = parties[index]
    const changes = typeof updater === 'function' ? updater(current) : updater
    const updated = normalizeParty({
      ...current,
      ...changes,
      id: current.id,
      updatedAt: new Date().toISOString(),
    })
    parties[index] = updated
    this.saveAll(parties)
    return updated
  }

  openParties() {
    return this.loadAll().filter((party) => party.status === 'open')
  }
}
