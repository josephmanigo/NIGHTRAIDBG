import { createClient } from '@supabase/supabase-js'
import {
  NIGHTY_DAILY_REWARDS,
  NIGHTY_MISSIONS,
  NIGHTY_STARTING_BALANCE,
} from './nighty-data.js'

const MIGRATION_FILES = 'database/phase19.sql through database/phase22.sql'

function requiredEnvironment(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function databaseError(error, fallback) {
  const detail = error?.message || error?.details || error?.hint
  return detail ? `${fallback} ${detail}` : fallback
}

function normalizePlayer(row = {}) {
  return {
    guildId: String(row.guild_id || row.guildId || ''),
    userId: String(row.user_id || row.userId || ''),
    balance: Number(row.balance) || 0,
    dailyStreak: Number(row.daily_streak ?? row.dailyStreak) || 0,
    lastDailyDate: row.last_daily_date || row.lastDailyDate || null,
    huntAvailableAt: row.hunt_available_at || row.huntAvailableAt || null,
    battleAvailableAt: row.battle_available_at || row.battleAvailableAt || null,
    totalHunts: Number(row.total_hunts ?? row.totalHunts) || 0,
    totalCaptures: Number(row.total_captures ?? row.totalCaptures) || 0,
    totalBattles: Number(row.total_battles ?? row.totalBattles) || 0,
    totalBattleWins: Number(row.total_battle_wins ?? row.totalBattleWins) || 0,
    createdAt: row.created_at || row.createdAt || null,
    updatedAt: row.updated_at || row.updatedAt || null,
  }
}

function normalizeRpcPlayer(data = {}) {
  return normalizePlayer({
    guild_id: data.guild_id,
    user_id: data.user_id,
    balance: data.balance,
    daily_streak: data.daily_streak,
    last_daily_date: data.last_daily_date,
    hunt_available_at: data.hunt_available_at,
    battle_available_at: data.battle_available_at,
    total_hunts: data.total_hunts,
    total_captures: data.total_captures,
    total_battles: data.total_battles,
    total_battle_wins: data.total_battle_wins,
  })
}

function normalizePvp(row = {}) {
  return {
    id: String(row.id || ''),
    guildId: String(row.guild_id || row.guildId || ''),
    channelId: String(row.channel_id || row.channelId || ''),
    challengerId: String(row.challenger_id || row.challengerId || ''),
    opponentId: String(row.opponent_id || row.opponentId || ''),
    wager: Number(row.wager) || 0,
    status: row.status || 'pending',
    winnerId: row.winner_id || row.winnerId || null,
    loserId: row.loser_id || row.loserId || null,
    expiresAt: row.expires_at || row.expiresAt || null,
    createdAt: row.created_at || row.createdAt || null,
    resolvedAt: row.resolved_at || row.resolvedAt || null,
  }
}

function normalizeTrade(row = {}) {
  return {
    id: String(row.id || ''),
    guildId: String(row.guild_id || row.guildId || ''),
    channelId: String(row.channel_id || row.channelId || ''),
    sellerId: String(row.seller_id || row.sellerId || ''),
    buyerId: String(row.buyer_id || row.buyerId || ''),
    characterId: row.character_id || row.characterId,
    quantity: Number(row.quantity) || 0,
    price: Number(row.price) || 0,
    status: row.status || 'pending',
    expiresAt: row.expires_at || row.expiresAt || null,
    createdAt: row.created_at || row.createdAt || null,
    resolvedAt: row.resolved_at || row.resolvedAt || null,
  }
}

function normalizeListing(row = {}) {
  return {
    id: String(row.id || ''),
    guildId: String(row.guild_id || row.guildId || ''),
    sellerId: String(row.seller_id || row.sellerId || ''),
    characterId: row.character_id || row.characterId,
    quantity: Number(row.quantity) || 0,
    price: Number(row.price) || 0,
    status: row.status || 'active',
    buyerId: row.buyer_id || row.buyerId || null,
    createdAt: row.created_at || row.createdAt || null,
    resolvedAt: row.resolved_at || row.resolvedAt || null,
  }
}

function normalizeGameSession(row = {}) {
  return {
    id: String(row.id || ''),
    guildId: String(row.guild_id || row.guildId || ''),
    channelId: String(row.channel_id || row.channelId || ''),
    userId: String(row.user_id || row.userId || ''),
    gameType: row.game_type || row.gameType || '',
    wager: Number(row.wager) || 0,
    state: row.state || {},
    status: row.status || 'active',
    outcome: row.outcome || null,
    payout: Number(row.payout) || 0,
    expiresAt: row.expires_at || row.expiresAt || null,
    createdAt: row.created_at || row.createdAt || null,
    resolvedAt: row.resolved_at || row.resolvedAt || null,
    startStatus: row.start_status || row.startStatus || null,
    balance: Number(row.balance) || 0,
    reason: row.reason || null,
  }
}

function normalizeGameStats(row = {}) {
  return {
    gameType: row.game_type || row.gameType || '',
    plays: Number(row.plays) || 0,
    wins: Number(row.wins) || 0,
    totalWagered: Number(row.total_wagered ?? row.totalWagered) || 0,
    totalPaid: Number(row.total_paid ?? row.totalPaid) || 0,
  }
}

function normalizeAdminAction(row = {}) {
  return {
    id: Number(row.id) || 0,
    guildId: String(row.guild_id || row.guildId || ''),
    adminId: String(row.admin_id || row.adminId || ''),
    targetId: String(row.target_id || row.targetId || ''),
    action: row.action || '',
    amount: Number(row.amount) || 0,
    balanceBefore: Number(row.balance_before ?? row.balanceBefore) || 0,
    balanceAfter: Number(row.balance_after ?? row.balanceAfter) || 0,
    reason: row.reason || '',
    actionId: String(row.action_id || row.actionId || ''),
    createdAt: row.created_at || row.createdAt || null,
    status: row.status || null,
  }
}

export class SupabaseNightyStore {
  constructor(client) {
    this.client = client
  }

  async initialize() {
    for (const table of [
      'nighty_players',
      'nighty_inventory',
      'nighty_mission_progress',
      'nighty_ledger',
      'nighty_pvp_challenges',
      'nighty_trade_offers',
      'nighty_market_listings',
      'nighty_game_sessions',
      'nighty_game_cooldowns',
      'nighty_game_stats',
      'nighty_admin_actions',
    ]) {
      const { error } = await this.client.from(table).select('*', { head: true, count: 'exact' }).limit(1)
      if (error) {
        throw new Error(databaseError(error, `Nighty storage is unavailable. Apply ${MIGRATION_FILES}.`))
      }
    }
  }

  async ensurePlayer({ guildId, userId }) {
    const { data, error } = await this.client.rpc('nighty_ensure_player', {
      p_guild_id: String(guildId),
      p_user_id: String(userId),
      p_starting_balance: NIGHTY_STARTING_BALANCE,
    })
    if (error) throw new Error(databaseError(error, 'Could not create or load the Nighty player.'))
    return { player: normalizeRpcPlayer(data), isNew: Boolean(data?.is_new) }
  }

  async getPlayer({ guildId, userId }) {
    const { data, error } = await this.client
      .from('nighty_players')
      .select('*')
      .eq('guild_id', String(guildId))
      .eq('user_id', String(userId))
      .maybeSingle()
    if (error) throw new Error(databaseError(error, 'Could not load the Nighty player.'))
    return data ? normalizePlayer(data) : null
  }

  async claimDaily({ guildId, userId, dailyKey, weeklyKey }) {
    const { data, error } = await this.client.rpc('nighty_claim_daily', {
      p_guild_id: String(guildId),
      p_user_id: String(userId),
      p_day: dailyKey,
      p_daily_key: dailyKey,
      p_weekly_key: weeklyKey,
    })
    if (error) throw new Error(databaseError(error, 'Could not claim the Nighty daily reward.'))
    return {
      status: data?.status,
      reward: Number(data?.reward) || 0,
      player: normalizeRpcPlayer(data),
    }
  }

  async recordHunt({
    guildId,
    userId,
    character,
    actionId,
    cooldownSeconds,
    dailyKey,
    weeklyKey,
  }) {
    const { data, error } = await this.client.rpc('nighty_record_hunt', {
      p_guild_id: String(guildId),
      p_user_id: String(userId),
      p_character_id: character.id,
      p_reward: character.reward,
      p_action_id: String(actionId),
      p_cooldown_seconds: cooldownSeconds,
      p_daily_key: dailyKey,
      p_weekly_key: weeklyKey,
    })
    if (error) throw new Error(databaseError(error, 'Could not record the Nighty hunt.'))
    return {
      status: data?.status,
      cooldownSeconds: Number(data?.cooldown_seconds) || 0,
      quantity: Number(data?.quantity) || 0,
      reward: Number(data?.reward) || 0,
      character,
      player: normalizeRpcPlayer(data),
    }
  }

  async getCollection({ guildId, userId }) {
    const { data, error } = await this.client
      .from('nighty_inventory')
      .select('character_id, quantity, first_captured_at, updated_at')
      .eq('guild_id', String(guildId))
      .eq('user_id', String(userId))
      .order('quantity', { ascending: false })
    if (error) throw new Error(databaseError(error, 'Could not load the Nighty collection.'))
    return (data || []).map((row) => ({
      characterId: row.character_id,
      quantity: Number(row.quantity) || 0,
      firstCapturedAt: row.first_captured_at,
      updatedAt: row.updated_at,
    }))
  }

  async getMissionProgress({ guildId, userId, dailyKey, weeklyKey }) {
    const { data, error } = await this.client
      .from('nighty_mission_progress')
      .select('period_type, period_key, mission_id, progress, claimed_at')
      .eq('guild_id', String(guildId))
      .eq('user_id', String(userId))
      .in('period_key', [dailyKey, weeklyKey])
    if (error) throw new Error(databaseError(error, 'Could not load Nighty missions.'))
    return (data || []).map((row) => ({
      periodType: row.period_type,
      periodKey: row.period_key,
      missionId: row.mission_id,
      progress: Number(row.progress) || 0,
      claimedAt: row.claimed_at,
    }))
  }

  async claimMission({ guildId, userId, periodKey, mission }) {
    const { data, error } = await this.client.rpc('nighty_claim_mission', {
      p_guild_id: String(guildId),
      p_user_id: String(userId),
      p_period_type: mission.periodType,
      p_period_key: periodKey,
      p_mission_id: mission.id,
      p_goal: mission.goal,
      p_reward: mission.reward,
    })
    if (error) throw new Error(databaseError(error, 'Could not claim the Nighty mission.'))
    return {
      status: data?.status,
      progress: Number(data?.progress) || 0,
      reward: Number(data?.reward) || 0,
      player: normalizeRpcPlayer(data),
    }
  }

  async recordBattle({ guildId, userId, battle, actionId, cooldownSeconds }) {
    const { data, error } = await this.client.rpc('nighty_record_battle', {
      p_guild_id: String(guildId),
      p_user_id: String(userId),
      p_enemy_id: battle.enemy.id,
      p_character_id: battle.character.id,
      p_won: battle.won,
      p_reward: battle.won ? battle.enemy.reward : 0,
      p_action_id: String(actionId),
      p_cooldown_seconds: cooldownSeconds,
    })
    if (error) throw new Error(databaseError(error, 'Could not record the Nighty battle.'))
    return {
      status: data?.status,
      cooldownSeconds: Number(data?.cooldown_seconds) || 0,
      reward: Number(data?.reward) || 0,
      battle,
      player: normalizeRpcPlayer(data),
    }
  }

  async createPvpChallenge(challenge) {
    const { data, error } = await this.client.rpc('nighty_create_pvp_challenge', {
      p_id: challenge.id,
      p_guild_id: String(challenge.guildId),
      p_channel_id: String(challenge.channelId),
      p_challenger_id: String(challenge.challengerId),
      p_opponent_id: String(challenge.opponentId),
      p_wager: challenge.wager,
      p_expires_at: challenge.expiresAt,
    })
    if (error) throw new Error(databaseError(error, 'Could not create the Nighty PvP challenge.'))
    return normalizePvp(data)
  }

  async getPvpChallenge(id) {
    const { data, error } = await this.client.from('nighty_pvp_challenges').select('*').eq('id', id).maybeSingle()
    if (error) throw new Error(databaseError(error, 'Could not load the Nighty PvP challenge.'))
    return data ? normalizePvp(data) : null
  }

  async resolvePvpChallenge({ challengeId, actorId, action, winnerId = null }) {
    const { data, error } = await this.client.rpc('nighty_resolve_pvp_challenge', {
      p_challenge_id: challengeId,
      p_actor_id: String(actorId),
      p_action: action,
      p_winner_id: winnerId,
    })
    if (error) throw new Error(databaseError(error, 'Could not resolve the Nighty PvP challenge.'))
    return { ...normalizePvp(data), status: data?.status, reason: data?.reason || null }
  }

  async createTradeOffer(offer) {
    const { data, error } = await this.client.rpc('nighty_create_trade_offer', {
      p_id: offer.id,
      p_guild_id: String(offer.guildId),
      p_channel_id: String(offer.channelId),
      p_seller_id: String(offer.sellerId),
      p_buyer_id: String(offer.buyerId),
      p_character_id: offer.characterId,
      p_quantity: offer.quantity,
      p_price: offer.price,
      p_expires_at: offer.expiresAt,
    })
    if (error) throw new Error(databaseError(error, 'Could not create the Nighty trade offer.'))
    return normalizeTrade(data)
  }

  async getTradeOffer(id) {
    const { data, error } = await this.client.from('nighty_trade_offers').select('*').eq('id', id).maybeSingle()
    if (error) throw new Error(databaseError(error, 'Could not load the Nighty trade offer.'))
    return data ? normalizeTrade(data) : null
  }

  async resolveTradeOffer({ offerId, actorId, action }) {
    const { data, error } = await this.client.rpc('nighty_resolve_trade_offer', {
      p_offer_id: offerId,
      p_actor_id: String(actorId),
      p_action: action,
    })
    if (error) throw new Error(databaseError(error, 'Could not resolve the Nighty trade offer.'))
    return { ...normalizeTrade(data), status: data?.status, reason: data?.reason || null }
  }

  async createMarketListing(listing) {
    const { data, error } = await this.client.rpc('nighty_create_market_listing', {
      p_id: listing.id,
      p_guild_id: String(listing.guildId),
      p_seller_id: String(listing.sellerId),
      p_character_id: listing.characterId,
      p_quantity: listing.quantity,
      p_price: listing.price,
    })
    if (error) throw new Error(databaseError(error, 'Could not create the Nighty market listing.'))
    return normalizeListing(data)
  }

  async listMarket({ guildId, limit = 10 }) {
    const { data, error } = await this.client
      .from('nighty_market_listings')
      .select('*')
      .eq('guild_id', String(guildId))
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(limit)
    if (error) throw new Error(databaseError(error, 'Could not load the Nighty market.'))
    return (data || []).map(normalizeListing)
  }

  async buyMarketListing({ listingId, buyerId }) {
    const { data, error } = await this.client.rpc('nighty_buy_market_listing', {
      p_listing_id: listingId,
      p_buyer_id: String(buyerId),
    })
    if (error) throw new Error(databaseError(error, 'Could not buy the Nighty market listing.'))
    return { ...normalizeListing(data), status: data?.status, reason: data?.reason || null }
  }

  async cancelMarketListing({ listingId, sellerId }) {
    const { data, error } = await this.client.rpc('nighty_cancel_market_listing', {
      p_listing_id: listingId,
      p_seller_id: String(sellerId),
    })
    if (error) throw new Error(databaseError(error, 'Could not cancel the Nighty market listing.'))
    return { ...normalizeListing(data), status: data?.status, reason: data?.reason || null }
  }

  async recordGameResult({
    guildId,
    userId,
    gameType,
    wager,
    payout,
    won,
    actionId,
    cooldownSeconds = 0,
    dailyKey,
    weeklyKey,
  }) {
    const { data, error } = await this.client.rpc('nighty_record_game_result', {
      p_guild_id: String(guildId),
      p_user_id: String(userId),
      p_game_type: gameType,
      p_wager: wager,
      p_payout: payout,
      p_won: Boolean(won),
      p_action_id: String(actionId),
      p_cooldown_seconds: cooldownSeconds,
      p_daily_key: dailyKey,
      p_weekly_key: weeklyKey,
    })
    if (error) throw new Error(databaseError(error, `Could not record the Nighty ${gameType} result.`))
    return {
      status: data?.status,
      cooldownSeconds: Number(data?.cooldown_seconds) || 0,
      wager: Number(data?.wager ?? wager) || 0,
      payout: Number(data?.payout ?? payout) || 0,
      net: Number(data?.net) || 0,
      player: normalizeRpcPlayer(data),
    }
  }

  async startGameSession(session) {
    const { data, error } = await this.client.rpc('nighty_start_game_session', {
      p_id: session.id,
      p_guild_id: String(session.guildId),
      p_channel_id: String(session.channelId),
      p_user_id: String(session.userId),
      p_game_type: session.gameType,
      p_wager: session.wager,
      p_state: session.state,
      p_expires_at: session.expiresAt,
    })
    if (error) throw new Error(databaseError(error, `Could not start the Nighty ${session.gameType} game.`))
    return normalizeGameSession(data)
  }

  async getGameSession(id) {
    const { data, error } = await this.client.from('nighty_game_sessions').select('*').eq('id', id).maybeSingle()
    if (error) throw new Error(databaseError(error, 'Could not load the Nighty game session.'))
    return data ? normalizeGameSession(data) : null
  }

  async getActiveGameSession({ guildId, userId, gameType, now = new Date() }) {
    const { data, error } = await this.client
      .from('nighty_game_sessions')
      .select('*')
      .eq('guild_id', String(guildId))
      .eq('user_id', String(userId))
      .eq('game_type', gameType)
      .eq('status', 'active')
      .gt('expires_at', new Date(now).toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) throw new Error(databaseError(error, 'Could not load the active Nighty game.'))
    return data ? normalizeGameSession(data) : null
  }

  async updateGameSession({ sessionId, userId, state }) {
    const { data, error } = await this.client.rpc('nighty_update_game_session', {
      p_session_id: sessionId,
      p_user_id: String(userId),
      p_state: state,
    })
    if (error) throw new Error(databaseError(error, 'Could not update the Nighty game session.'))
    return normalizeGameSession(data)
  }

  async completeGameSession({ sessionId, userId, state, outcome, payout, won, dailyKey, weeklyKey }) {
    const { data, error } = await this.client.rpc('nighty_complete_game_session', {
      p_session_id: sessionId,
      p_user_id: String(userId),
      p_state: state,
      p_outcome: outcome,
      p_payout: payout,
      p_won: Boolean(won),
      p_daily_key: dailyKey,
      p_weekly_key: weeklyKey,
    })
    if (error) throw new Error(databaseError(error, 'Could not complete the Nighty game session.'))
    return normalizeGameSession(data)
  }

  async getGameStats({ guildId, userId }) {
    const { data, error } = await this.client
      .from('nighty_game_stats')
      .select('game_type, plays, wins, total_wagered, total_paid')
      .eq('guild_id', String(guildId))
      .eq('user_id', String(userId))
      .order('plays', { ascending: false })
    if (error) throw new Error(databaseError(error, 'Could not load Nighty game statistics.'))
    return (data || []).map(normalizeGameStats)
  }

  async getLeaderboard({ guildId, limit = 10 }) {
    const { data, error } = await this.client
      .from('nighty_players')
      .select('guild_id, user_id, balance, total_hunts, total_captures, total_battles, total_battle_wins')
      .eq('guild_id', String(guildId))
      .order('balance', { ascending: false })
      .limit(limit)
    if (error) throw new Error(databaseError(error, 'Could not load the Nighty leaderboard.'))
    return (data || []).map(normalizePlayer)
  }

  async adminAdjustBalance({ guildId, adminId, targetId, operation, amount, reason, actionId }) {
    const { data, error } = await this.client.rpc('nighty_admin_adjust_balance', {
      p_guild_id: String(guildId),
      p_admin_id: String(adminId),
      p_target_id: String(targetId),
      p_operation: operation,
      p_amount: amount,
      p_reason: reason,
      p_action_id: String(actionId),
    })
    if (error) throw new Error(databaseError(error, 'Could not apply the Nighty balance adjustment.'))
    return {
      ...normalizeAdminAction(data),
      status: data?.status,
      player: normalizeRpcPlayer(data),
    }
  }

  async adminResetCooldowns({ guildId, adminId, targetId, reason, actionId }) {
    const { data, error } = await this.client.rpc('nighty_admin_reset_cooldowns', {
      p_guild_id: String(guildId),
      p_admin_id: String(adminId),
      p_target_id: String(targetId),
      p_reason: reason,
      p_action_id: String(actionId),
    })
    if (error) throw new Error(databaseError(error, 'Could not reset the Nighty cooldowns.'))
    return {
      ...normalizeAdminAction(data),
      status: data?.status,
      player: normalizeRpcPlayer(data),
    }
  }

  async getAdminAudit({ guildId, targetId = null, limit = 10 }) {
    let query = this.client
      .from('nighty_admin_actions')
      .select('*')
      .eq('guild_id', String(guildId))
      .order('created_at', { ascending: false })
      .limit(limit)
    if (targetId) query = query.eq('target_id', String(targetId))
    const { data, error } = await query
    if (error) throw new Error(databaseError(error, 'Could not load the Nighty admin audit.'))
    return (data || []).map(normalizeAdminAction)
  }

  async getEconomySummary({ guildId }) {
    const { data, error } = await this.client.rpc('nighty_economy_summary', { p_guild_id: String(guildId) })
    if (error) throw new Error(databaseError(error, 'Could not load the Nighty economy summary.'))
    return {
      players: Number(data?.players) || 0,
      totalCurrency: Number(data?.total_currency) || 0,
      averageBalance: Number(data?.average_balance) || 0,
      activeListings: Number(data?.active_listings) || 0,
      activeChallenges: Number(data?.active_challenges) || 0,
      activeTrades: Number(data?.active_trades) || 0,
      activeSessions: Number(data?.active_sessions) || 0,
      ledgerEntries: Number(data?.ledger_entries) || 0,
    }
  }
}

export function createSupabaseNightyStore(options = {}) {
  const client = options.client ?? createClient(
    options.supabaseUrl ?? requiredEnvironment('SUPABASE_URL'),
    options.supabaseSecretKey ?? requiredEnvironment('SUPABASE_SECRET_KEY'),
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    },
  )
  return new SupabaseNightyStore(client)
}

function playerKey(guildId, userId) {
  return `${guildId}:${userId}`
}

function missionKey(guildId, userId, periodType, periodKey, missionId) {
  return `${playerKey(guildId, userId)}:${periodType}:${periodKey}:${missionId}`
}

function previousDay(dayKey) {
  const value = new Date(`${dayKey}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() - 1)
  return value.toISOString().slice(0, 10)
}

export class MemoryNightyStore {
  constructor() {
    this.players = new Map()
    this.inventory = new Map()
    this.missions = new Map()
    this.actions = new Set()
    this.pvpChallenges = new Map()
    this.tradeOffers = new Map()
    this.marketListings = new Map()
    this.gameSessions = new Map()
    this.gameCooldowns = new Map()
    this.gameStats = new Map()
    this.adminActions = []
    this.adminActionCounter = 0
  }

  async initialize() {}

  async ensurePlayer({ guildId, userId }) {
    const key = playerKey(guildId, userId)
    const existing = this.players.get(key)
    if (existing) return { player: { ...existing }, isNew: false }
    const player = {
      guildId: String(guildId),
      userId: String(userId),
      balance: NIGHTY_STARTING_BALANCE,
      dailyStreak: 0,
      lastDailyDate: null,
      huntAvailableAt: null,
      battleAvailableAt: null,
      totalHunts: 0,
      totalCaptures: 0,
      totalBattles: 0,
      totalBattleWins: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    this.players.set(key, player)
    return { player: { ...player }, isNew: true }
  }

  async getPlayer({ guildId, userId }) {
    const player = this.players.get(playerKey(guildId, userId))
    return player ? { ...player } : null
  }

  incrementMission({ guildId, userId, periodType, periodKey, event, amount }) {
    for (const mission of NIGHTY_MISSIONS) {
      if (mission.periodType !== periodType || mission.event !== event) continue
      const key = missionKey(guildId, userId, periodType, periodKey, mission.id)
      const current = this.missions.get(key) || {
        periodType,
        periodKey,
        missionId: mission.id,
        progress: 0,
        claimedAt: null,
      }
      current.progress += amount
      this.missions.set(key, current)
    }
  }

  async claimDaily({ guildId, userId, dailyKey, weeklyKey }) {
    const { player } = await this.ensurePlayer({ guildId, userId })
    const stored = this.players.get(playerKey(guildId, userId))
    if (stored.lastDailyDate === dailyKey) {
      return { status: 'already_claimed', reward: 0, player: { ...stored } }
    }
    stored.dailyStreak = stored.lastDailyDate === previousDay(dailyKey)
      ? Math.min(7, stored.dailyStreak + 1)
      : 1
    const reward = NIGHTY_DAILY_REWARDS[stored.dailyStreak - 1]
    stored.lastDailyDate = dailyKey
    stored.balance += reward
    stored.updatedAt = new Date().toISOString()
    this.incrementMission({ guildId, userId, periodType: 'daily', periodKey: dailyKey, event: 'daily_claim', amount: 1 })
    this.incrementMission({ guildId, userId, periodType: 'weekly', periodKey: weeklyKey, event: 'currency_earned', amount: reward })
    return { status: 'claimed', reward, player: { ...stored } }
  }

  async recordHunt({
    guildId,
    userId,
    character,
    actionId,
    cooldownSeconds,
    dailyKey,
    weeklyKey,
    now = new Date(),
  }) {
    const actionKey = `${guildId}:${userId}:hunt:${actionId}`
    const { player } = await this.ensurePlayer({ guildId, userId })
    const stored = this.players.get(playerKey(guildId, userId))
    if (this.actions.has(actionKey)) {
      return { status: 'duplicate', reward: character.reward, character, player: { ...stored }, quantity: 0 }
    }
    const availableAt = stored.huntAvailableAt ? new Date(stored.huntAvailableAt).getTime() : 0
    const currentTime = new Date(now).getTime()
    if (availableAt > currentTime) {
      return {
        status: 'cooldown',
        cooldownSeconds: Math.max(1, Math.ceil((availableAt - currentTime) / 1000)),
        character,
        player: { ...stored },
        quantity: 0,
      }
    }

    this.actions.add(actionKey)
    stored.balance += character.reward
    stored.totalHunts += 1
    stored.totalCaptures += 1
    stored.huntAvailableAt = new Date(currentTime + cooldownSeconds * 1000).toISOString()
    stored.updatedAt = new Date().toISOString()
    const inventoryKey = `${playerKey(guildId, userId)}:${character.id}`
    const item = this.inventory.get(inventoryKey) || {
      characterId: character.id,
      quantity: 0,
      firstCapturedAt: new Date(now).toISOString(),
    }
    item.quantity += 1
    item.updatedAt = new Date(now).toISOString()
    this.inventory.set(inventoryKey, item)
    for (const periodType of ['daily', 'weekly']) {
      const periodKey = periodType === 'daily' ? dailyKey : weeklyKey
      this.incrementMission({ guildId, userId, periodType, periodKey, event: 'hunt', amount: 1 })
      this.incrementMission({ guildId, userId, periodType, periodKey, event: 'capture', amount: 1 })
    }
    this.incrementMission({ guildId, userId, periodType: 'weekly', periodKey: weeklyKey, event: 'currency_earned', amount: character.reward })
    return {
      status: 'captured',
      cooldownSeconds,
      quantity: item.quantity,
      reward: character.reward,
      character,
      player: { ...stored },
    }
  }

  async getCollection({ guildId, userId }) {
    const prefix = `${playerKey(guildId, userId)}:`
    return [...this.inventory.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, item]) => ({ ...item }))
      .sort((a, b) => b.quantity - a.quantity)
  }

  async getMissionProgress({ guildId, userId, dailyKey, weeklyKey }) {
    const wanted = new Set([dailyKey, weeklyKey])
    const prefix = `${playerKey(guildId, userId)}:`
    return [...this.missions.entries()]
      .filter(([key, value]) => key.startsWith(prefix) && wanted.has(value.periodKey))
      .map(([, value]) => ({ ...value }))
  }

  async claimMission({ guildId, userId, periodKey, mission }) {
    await this.ensurePlayer({ guildId, userId })
    const key = missionKey(guildId, userId, mission.periodType, periodKey, mission.id)
    const progress = this.missions.get(key) || {
      periodType: mission.periodType,
      periodKey,
      missionId: mission.id,
      progress: 0,
      claimedAt: null,
    }
    if (progress.claimedAt) return { status: 'already_claimed', progress: progress.progress, reward: 0, player: await this.getPlayer({ guildId, userId }) }
    if (progress.progress < mission.goal) return { status: 'locked', progress: progress.progress, reward: 0, player: await this.getPlayer({ guildId, userId }) }
    progress.claimedAt = new Date().toISOString()
    this.missions.set(key, progress)
    const stored = this.players.get(playerKey(guildId, userId))
    stored.balance += mission.reward
    stored.updatedAt = new Date().toISOString()
    return { status: 'claimed', progress: progress.progress, reward: mission.reward, player: { ...stored } }
  }

  async recordBattle({ guildId, userId, battle, actionId, cooldownSeconds, now = new Date() }) {
    await this.ensurePlayer({ guildId, userId })
    const stored = this.players.get(playerKey(guildId, userId))
    const actionKey = `${guildId}:${userId}:battle:${actionId}`
    if (this.actions.has(actionKey)) {
      return { status: 'duplicate', reward: battle.won ? battle.enemy.reward : 0, battle, player: { ...stored } }
    }
    const currentTime = new Date(now).getTime()
    const availableAt = stored.battleAvailableAt ? new Date(stored.battleAvailableAt).getTime() : 0
    if (availableAt > currentTime) {
      return {
        status: 'cooldown',
        cooldownSeconds: Math.max(1, Math.ceil((availableAt - currentTime) / 1000)),
        battle,
        reward: 0,
        player: { ...stored },
      }
    }
    this.actions.add(actionKey)
    const reward = battle.won ? battle.enemy.reward : 0
    stored.balance += reward
    stored.totalBattles += 1
    if (battle.won) stored.totalBattleWins += 1
    stored.battleAvailableAt = new Date(currentTime + cooldownSeconds * 1000).toISOString()
    stored.updatedAt = new Date(now).toISOString()
    return { status: 'resolved', cooldownSeconds, reward, battle, player: { ...stored } }
  }

  async createPvpChallenge(challenge) {
    const challenger = await this.getPlayer({ guildId: challenge.guildId, userId: challenge.challengerId })
    const opponent = await this.getPlayer({ guildId: challenge.guildId, userId: challenge.opponentId })
    if (!challenger || !opponent) throw new Error('Both PvP players must have Nighty profiles.')
    if (challenger.balance < challenge.wager) throw new Error('The challenger does not have enough Night Currency.')
    const record = { ...challenge, status: 'pending', winnerId: null, loserId: null, createdAt: new Date().toISOString(), resolvedAt: null }
    this.pvpChallenges.set(record.id, record)
    return { ...record }
  }

  async getPvpChallenge(id) {
    const record = this.pvpChallenges.get(id)
    return record ? { ...record } : null
  }

  async resolvePvpChallenge({ challengeId, actorId, action, winnerId = null, now = new Date() }) {
    const challenge = this.pvpChallenges.get(challengeId)
    if (!challenge) return { status: 'missing', reason: 'missing' }
    if (challenge.status !== 'pending') return { ...challenge, status: challenge.status, reason: 'already_resolved' }
    if (String(actorId) !== challenge.opponentId) return { ...challenge, status: 'forbidden', reason: 'opponent_only' }
    if (new Date(challenge.expiresAt).getTime() <= new Date(now).getTime()) {
      challenge.status = 'expired'
      challenge.resolvedAt = new Date(now).toISOString()
      return { ...challenge }
    }
    if (action === 'decline') {
      challenge.status = 'declined'
      challenge.resolvedAt = new Date(now).toISOString()
      return { ...challenge }
    }
    const challenger = this.players.get(playerKey(challenge.guildId, challenge.challengerId))
    const opponent = this.players.get(playerKey(challenge.guildId, challenge.opponentId))
    if (challenger.balance < challenge.wager || opponent.balance < challenge.wager) {
      challenge.status = 'cancelled'
      challenge.resolvedAt = new Date(now).toISOString()
      return { ...challenge, reason: 'insufficient_balance' }
    }
    if (![challenge.challengerId, challenge.opponentId].includes(String(winnerId))) {
      throw new Error('PvP winner must be one of the challenged players.')
    }
    const loserId = winnerId === challenge.challengerId ? challenge.opponentId : challenge.challengerId
    const winner = this.players.get(playerKey(challenge.guildId, winnerId))
    const loser = this.players.get(playerKey(challenge.guildId, loserId))
    loser.balance -= challenge.wager
    winner.balance += challenge.wager
    challenge.status = 'completed'
    challenge.winnerId = winnerId
    challenge.loserId = loserId
    challenge.resolvedAt = new Date(now).toISOString()
    return { ...challenge }
  }

  async createTradeOffer(offer) {
    const seller = await this.getPlayer({ guildId: offer.guildId, userId: offer.sellerId })
    const buyer = await this.getPlayer({ guildId: offer.guildId, userId: offer.buyerId })
    if (!seller || !buyer) throw new Error('Both traders must have Nighty profiles.')
    const inventoryKey = `${playerKey(offer.guildId, offer.sellerId)}:${offer.characterId}`
    if ((this.inventory.get(inventoryKey)?.quantity || 0) < offer.quantity) throw new Error('The seller does not own enough of that character.')
    const record = { ...offer, status: 'pending', createdAt: new Date().toISOString(), resolvedAt: null }
    this.tradeOffers.set(record.id, record)
    return { ...record }
  }

  async getTradeOffer(id) {
    const record = this.tradeOffers.get(id)
    return record ? { ...record } : null
  }

  async resolveTradeOffer({ offerId, actorId, action, now = new Date() }) {
    const offer = this.tradeOffers.get(offerId)
    if (!offer) return { status: 'missing', reason: 'missing' }
    if (offer.status !== 'pending') return { ...offer, status: offer.status, reason: 'already_resolved' }
    if (String(actorId) !== offer.buyerId) return { ...offer, status: 'forbidden', reason: 'buyer_only' }
    if (new Date(offer.expiresAt).getTime() <= new Date(now).getTime()) {
      offer.status = 'expired'
      offer.resolvedAt = new Date(now).toISOString()
      return { ...offer }
    }
    if (action === 'decline') {
      offer.status = 'declined'
      offer.resolvedAt = new Date(now).toISOString()
      return { ...offer }
    }
    const seller = this.players.get(playerKey(offer.guildId, offer.sellerId))
    const buyer = this.players.get(playerKey(offer.guildId, offer.buyerId))
    const sellerItemKey = `${playerKey(offer.guildId, offer.sellerId)}:${offer.characterId}`
    const buyerItemKey = `${playerKey(offer.guildId, offer.buyerId)}:${offer.characterId}`
    const sellerItem = this.inventory.get(sellerItemKey)
    if (!sellerItem || sellerItem.quantity < offer.quantity) {
      offer.status = 'cancelled'
      offer.resolvedAt = new Date(now).toISOString()
      return { ...offer, reason: 'insufficient_inventory' }
    }
    if (buyer.balance < offer.price) {
      offer.status = 'cancelled'
      offer.resolvedAt = new Date(now).toISOString()
      return { ...offer, reason: 'insufficient_balance' }
    }
    sellerItem.quantity -= offer.quantity
    const buyerItem = this.inventory.get(buyerItemKey) || { characterId: offer.characterId, quantity: 0, firstCapturedAt: new Date(now).toISOString() }
    buyerItem.quantity += offer.quantity
    buyerItem.updatedAt = new Date(now).toISOString()
    this.inventory.set(buyerItemKey, buyerItem)
    seller.balance += offer.price
    buyer.balance -= offer.price
    offer.status = 'completed'
    offer.resolvedAt = new Date(now).toISOString()
    return { ...offer }
  }

  async createMarketListing(listing) {
    const itemKey = `${playerKey(listing.guildId, listing.sellerId)}:${listing.characterId}`
    const item = this.inventory.get(itemKey)
    if (!item || item.quantity < listing.quantity) throw new Error('You do not own enough of that character.')
    item.quantity -= listing.quantity
    const record = { ...listing, status: 'active', buyerId: null, createdAt: new Date().toISOString(), resolvedAt: null }
    this.marketListings.set(record.id, record)
    return { ...record }
  }

  async listMarket({ guildId, limit = 10 }) {
    return [...this.marketListings.values()]
      .filter((listing) => listing.guildId === String(guildId) && listing.status === 'active')
      .slice(0, limit)
      .map((listing) => ({ ...listing }))
  }

  async buyMarketListing({ listingId, buyerId, now = new Date() }) {
    const listing = this.marketListings.get(listingId)
    if (!listing) return { status: 'missing', reason: 'missing' }
    if (listing.status !== 'active') return { ...listing, reason: 'not_active' }
    if (listing.sellerId === String(buyerId)) return { ...listing, status: 'forbidden', reason: 'own_listing' }
    const buyer = this.players.get(playerKey(listing.guildId, buyerId))
    const seller = this.players.get(playerKey(listing.guildId, listing.sellerId))
    if (!buyer || buyer.balance < listing.price) return { ...listing, status: 'cancelled', reason: 'insufficient_balance' }
    buyer.balance -= listing.price
    seller.balance += listing.price
    const itemKey = `${playerKey(listing.guildId, buyerId)}:${listing.characterId}`
    const item = this.inventory.get(itemKey) || { characterId: listing.characterId, quantity: 0, firstCapturedAt: new Date(now).toISOString() }
    item.quantity += listing.quantity
    item.updatedAt = new Date(now).toISOString()
    this.inventory.set(itemKey, item)
    listing.status = 'sold'
    listing.buyerId = String(buyerId)
    listing.resolvedAt = new Date(now).toISOString()
    return { ...listing }
  }

  async cancelMarketListing({ listingId, sellerId, now = new Date() }) {
    const listing = this.marketListings.get(listingId)
    if (!listing) return { status: 'missing', reason: 'missing' }
    if (listing.status !== 'active') return { ...listing, reason: 'not_active' }
    if (listing.sellerId !== String(sellerId)) return { ...listing, status: 'forbidden', reason: 'seller_only' }
    const itemKey = `${playerKey(listing.guildId, sellerId)}:${listing.characterId}`
    const item = this.inventory.get(itemKey) || { characterId: listing.characterId, quantity: 0, firstCapturedAt: new Date(now).toISOString() }
    item.quantity += listing.quantity
    item.updatedAt = new Date(now).toISOString()
    this.inventory.set(itemKey, item)
    listing.status = 'cancelled'
    listing.resolvedAt = new Date(now).toISOString()
    return { ...listing }
  }

  incrementGameStats({ guildId, userId, gameType, wager, payout, won }) {
    const key = `${playerKey(guildId, userId)}:${gameType}`
    const stats = this.gameStats.get(key) || { gameType, plays: 0, wins: 0, totalWagered: 0, totalPaid: 0 }
    stats.plays += 1
    if (won) stats.wins += 1
    stats.totalWagered += wager
    stats.totalPaid += payout
    this.gameStats.set(key, stats)
  }

  recordGameMissionProgress({ guildId, userId, dailyKey, weeklyKey, net }) {
    this.incrementMission({ guildId, userId, periodType: 'daily', periodKey: dailyKey, event: 'game_played', amount: 1 })
    this.incrementMission({ guildId, userId, periodType: 'weekly', periodKey: weeklyKey, event: 'game_played', amount: 1 })
    if (net > 0) this.incrementMission({ guildId, userId, periodType: 'weekly', periodKey: weeklyKey, event: 'currency_earned', amount: net })
  }

  async recordGameResult({
    guildId,
    userId,
    gameType,
    wager,
    payout,
    won,
    actionId,
    cooldownSeconds = 0,
    dailyKey,
    weeklyKey,
    now = new Date(),
  }) {
    await this.ensurePlayer({ guildId, userId })
    const player = this.players.get(playerKey(guildId, userId))
    const actionKey = `${guildId}:${userId}:game:${gameType}:${actionId}`
    if (this.actions.has(actionKey)) {
      return { status: 'duplicate', wager, payout, net: payout - wager, player: { ...player } }
    }
    const currentTime = new Date(now).getTime()
    const cooldownKey = `${playerKey(guildId, userId)}:${gameType}`
    const availableAt = this.gameCooldowns.get(cooldownKey)
    if (availableAt && new Date(availableAt).getTime() > currentTime) {
      return {
        status: 'cooldown',
        cooldownSeconds: Math.max(1, Math.ceil((new Date(availableAt).getTime() - currentTime) / 1000)),
        wager: 0,
        payout: 0,
        net: 0,
        player: { ...player },
      }
    }
    if (player.balance < wager) return { status: 'insufficient_balance', wager, payout: 0, net: 0, player: { ...player } }
    this.actions.add(actionKey)
    const net = payout - wager
    player.balance += net
    player.updatedAt = new Date(now).toISOString()
    if (cooldownSeconds > 0) {
      this.gameCooldowns.set(cooldownKey, new Date(currentTime + cooldownSeconds * 1000).toISOString())
    }
    this.incrementGameStats({ guildId, userId, gameType, wager, payout, won })
    this.recordGameMissionProgress({ guildId, userId, dailyKey, weeklyKey, net })
    return { status: 'resolved', cooldownSeconds, wager, payout, net, player: { ...player } }
  }

  async startGameSession(session) {
    const now = new Date(session.now || new Date())
    await this.ensurePlayer({ guildId: session.guildId, userId: session.userId })
    for (const existing of this.gameSessions.values()) {
      if (existing.guildId !== String(session.guildId)
        || existing.userId !== String(session.userId)
        || existing.gameType !== session.gameType
        || existing.status !== 'active') continue
      if (new Date(existing.expiresAt).getTime() > now.getTime()) return { ...existing, startStatus: 'existing' }
      existing.status = 'expired'
      existing.resolvedAt = now.toISOString()
    }
    const player = this.players.get(playerKey(session.guildId, session.userId))
    if (player.balance < session.wager) {
      return { ...session, status: 'rejected', startStatus: 'insufficient_balance', balance: player.balance }
    }
    player.balance -= session.wager
    player.updatedAt = now.toISOString()
    const record = {
      id: session.id,
      guildId: String(session.guildId),
      channelId: String(session.channelId),
      userId: String(session.userId),
      gameType: session.gameType,
      wager: session.wager,
      state: structuredClone(session.state),
      status: 'active',
      outcome: null,
      payout: 0,
      expiresAt: session.expiresAt,
      createdAt: now.toISOString(),
      resolvedAt: null,
      startStatus: 'created',
      balance: player.balance,
    }
    this.gameSessions.set(record.id, record)
    return { ...record, state: structuredClone(record.state) }
  }

  async getGameSession(id) {
    const session = this.gameSessions.get(id)
    return session ? { ...session, state: structuredClone(session.state) } : null
  }

  async getActiveGameSession({ guildId, userId, gameType, now = new Date() }) {
    return [...this.gameSessions.values()]
      .filter((session) => session.guildId === String(guildId)
        && session.userId === String(userId)
        && session.gameType === gameType
        && session.status === 'active'
        && new Date(session.expiresAt).getTime() > new Date(now).getTime())
      .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt))
      .map((session) => ({ ...session, state: structuredClone(session.state) }))[0] || null
  }

  async updateGameSession({ sessionId, userId, state, now = new Date() }) {
    const session = this.gameSessions.get(sessionId)
    if (!session) return { status: 'missing', reason: 'missing' }
    if (session.userId !== String(userId)) return { ...session, status: 'forbidden', reason: 'owner_only' }
    if (session.status !== 'active') return { ...session, reason: 'already_resolved' }
    if (new Date(session.expiresAt).getTime() <= new Date(now).getTime()) {
      session.status = 'expired'
      session.resolvedAt = new Date(now).toISOString()
      return { ...session }
    }
    session.state = structuredClone(state)
    return { ...session, state: structuredClone(session.state) }
  }

  async completeGameSession({ sessionId, userId, state, outcome, payout, won, dailyKey, weeklyKey, now = new Date() }) {
    const session = this.gameSessions.get(sessionId)
    if (!session) return { status: 'missing', reason: 'missing' }
    if (session.userId !== String(userId)) return { ...session, status: 'forbidden', reason: 'owner_only' }
    if (session.status !== 'active') return { ...session, reason: 'already_resolved' }
    if (new Date(session.expiresAt).getTime() <= new Date(now).getTime()) {
      session.status = 'expired'
      session.outcome = 'expired'
      session.resolvedAt = new Date(now).toISOString()
      return { ...session }
    }
    const player = this.players.get(playerKey(session.guildId, session.userId))
    player.balance += payout
    player.updatedAt = new Date(now).toISOString()
    session.state = structuredClone(state)
    session.status = 'completed'
    session.outcome = outcome
    session.payout = payout
    session.resolvedAt = new Date(now).toISOString()
    session.balance = player.balance
    this.incrementGameStats({
      guildId: session.guildId,
      userId: session.userId,
      gameType: session.gameType,
      wager: session.wager,
      payout,
      won,
    })
    this.recordGameMissionProgress({
      guildId: session.guildId,
      userId: session.userId,
      dailyKey,
      weeklyKey,
      net: payout - session.wager,
    })
    return { ...session, state: structuredClone(session.state) }
  }

  async getGameStats({ guildId, userId }) {
    const prefix = `${playerKey(guildId, userId)}:`
    return [...this.gameStats.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, stats]) => ({ ...stats }))
      .sort((left, right) => right.plays - left.plays)
  }

  async getLeaderboard({ guildId, limit = 10 }) {
    const prefix = `${guildId}:`
    return [...this.players.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, player]) => ({ ...player }))
      .sort((left, right) => right.balance - left.balance || left.userId.localeCompare(right.userId))
      .slice(0, limit)
  }

  async adminAdjustBalance({ guildId, adminId, targetId, operation, amount, reason, actionId, now = new Date() }) {
    const duplicate = this.adminActions.find((item) => item.guildId === String(guildId) && item.actionId === String(actionId))
    if (duplicate) {
      return {
        ...duplicate,
        status: 'duplicate',
        player: await this.getPlayer({ guildId, userId: duplicate.targetId }),
      }
    }
    const player = this.players.get(playerKey(guildId, targetId))
    if (!player) return { status: 'missing_player', player: null }
    const balanceBefore = player.balance
    let balanceAfter = balanceBefore
    if (operation === 'grant') balanceAfter += amount
    else if (operation === 'remove') balanceAfter -= amount
    else if (operation === 'set') balanceAfter = amount
    else throw new Error('Unknown Nighty admin balance operation.')
    if (balanceAfter < 0) return { status: 'insufficient_balance', player: { ...player } }
    player.balance = balanceAfter
    player.updatedAt = new Date(now).toISOString()
    const action = {
      id: ++this.adminActionCounter,
      guildId: String(guildId),
      adminId: String(adminId),
      targetId: String(targetId),
      action: operation,
      amount,
      balanceBefore,
      balanceAfter,
      reason,
      actionId: String(actionId),
      createdAt: new Date(now).toISOString(),
    }
    this.adminActions.push(action)
    return { ...action, status: 'applied', player: { ...player } }
  }

  async adminResetCooldowns({ guildId, adminId, targetId, reason, actionId, now = new Date() }) {
    const duplicate = this.adminActions.find((item) => item.guildId === String(guildId) && item.actionId === String(actionId))
    if (duplicate) {
      return {
        ...duplicate,
        status: 'duplicate',
        player: await this.getPlayer({ guildId, userId: duplicate.targetId }),
      }
    }
    const player = this.players.get(playerKey(guildId, targetId))
    if (!player) return { status: 'missing_player', player: null }
    player.huntAvailableAt = null
    player.battleAvailableAt = null
    player.updatedAt = new Date(now).toISOString()
    const prefix = `${playerKey(guildId, targetId)}:`
    for (const key of this.gameCooldowns.keys()) {
      if (key.startsWith(prefix)) this.gameCooldowns.delete(key)
    }
    const action = {
      id: ++this.adminActionCounter,
      guildId: String(guildId),
      adminId: String(adminId),
      targetId: String(targetId),
      action: 'reset_cooldowns',
      amount: 0,
      balanceBefore: player.balance,
      balanceAfter: player.balance,
      reason,
      actionId: String(actionId),
      createdAt: new Date(now).toISOString(),
    }
    this.adminActions.push(action)
    return { ...action, status: 'applied', player: { ...player } }
  }

  async getAdminAudit({ guildId, targetId = null, limit = 10 }) {
    return this.adminActions
      .filter((item) => item.guildId === String(guildId) && (!targetId || item.targetId === String(targetId)))
      .slice(-limit)
      .reverse()
      .map((item) => ({ ...item }))
  }

  async getEconomySummary({ guildId }) {
    const players = await this.getLeaderboard({ guildId, limit: Number.MAX_SAFE_INTEGER })
    const totalCurrency = players.reduce((sum, player) => sum + player.balance, 0)
    return {
      players: players.length,
      totalCurrency,
      averageBalance: players.length > 0 ? Math.floor(totalCurrency / players.length) : 0,
      activeListings: [...this.marketListings.values()].filter((item) => item.guildId === String(guildId) && item.status === 'active').length,
      activeChallenges: [...this.pvpChallenges.values()].filter((item) => item.guildId === String(guildId) && item.status === 'pending').length,
      activeTrades: [...this.tradeOffers.values()].filter((item) => item.guildId === String(guildId) && item.status === 'pending').length,
      activeSessions: [...this.gameSessions.values()].filter((item) => item.guildId === String(guildId) && item.status === 'active').length,
      ledgerEntries: this.actions.size + this.adminActions.length,
    }
  }
}
