import { Events } from 'discord.js'
import { midnightNrtStore } from './midnight-nrt-store.js'

export const DEFAULT_NRT_REACTION_CHANNEL_ID = '1208607689953779712'
export const GUESS_WIN_NRT = 50
export const POST_REACTION_NRT = 10

const GAME_TYPES = new Set(['number', 'word', 'emoji'])

function requiredId(value, name) {
  const id = String(value ?? '').trim()
  if (!id) throw new Error(`${name} is required for an automatic NRT award.`)
  return id
}

export function guessWinAwardKey(gameType, sourceMessageId) {
  const type = String(gameType ?? '').trim().toLowerCase()
  if (!GAME_TYPES.has(type)) throw new Error('Unknown guessing-game type.')
  return `guess_win:${type}:${requiredId(sourceMessageId, 'sourceMessageId')}`
}

export function postReactionAwardKey(sourceMessageId, userId) {
  return `post_reaction:${requiredId(sourceMessageId, 'sourceMessageId')}:${requiredId(userId, 'userId')}`
}

export function renderNrtAwardLine(award) {
  if (!award) return null
  const amount = Number.isFinite(Number(award.amount)) ? Number(award.amount) : GUESS_WIN_NRT
  const balance = Number.isFinite(Number(award.balance)) ? Number(award.balance) : null
  if (award.status === 'awarded') {
    return `NRT Reward: **+${amount} NRT**.${balance === null ? '' : ` New balance: **${balance} NRT**.`}`
  }
  if (award.status === 'duplicate') {
    return `NRT Reward: **${amount} NRT was already credited**.${balance === null ? '' : ` Current balance: **${balance} NRT**.`}`
  }
  if (award.status === 'error') {
    return 'NRT Reward: **Automatic credit could not be confirmed.** Staff have been notified.'
  }
  return null
}

function errorText(reason) {
  return reason instanceof Error ? reason.message : String(reason)
}

function report(options, scope, reason, context) {
  try {
    options.errorReporter?.report?.(scope, reason, context)
  } catch (reportReason) {
    console.error('[NRT rewards] Error reporter failed:', errorText(reportReason))
  }
  console.error(`[NRT rewards] ${scope}:`, errorText(reason))
}

async function resolveReactionEvent(reaction, user) {
  let resolvedReaction = reaction
  if (resolvedReaction?.partial) {
    if (typeof resolvedReaction.fetch !== 'function') throw new Error('Partial reaction cannot be fetched.')
    resolvedReaction = await resolvedReaction.fetch()
  }

  let message = resolvedReaction?.message
  if (message?.partial) {
    if (typeof message.fetch !== 'function') throw new Error('Partial reaction message cannot be fetched.')
    message = await message.fetch()
  }

  let resolvedUser = user
  if (resolvedUser?.partial && typeof resolvedUser.fetch === 'function') {
    resolvedUser = await resolvedUser.fetch()
  }
  return { reaction: resolvedReaction, message, user: resolvedUser }
}

function isTargetChannel(message, targetChannelId) {
  const channelId = String(message?.channelId ?? message?.channel?.id ?? '')
  const parentId = String(message?.channel?.parentId ?? '')
  return channelId === targetChannelId || parentId === targetChannelId
}

export function createNrtRewardsWorkflow(options = {}) {
  const store = options.store ?? midnightNrtStore
  const targetChannelId = String(
    options.reactionChannelId
      ?? process.env.NRT_REACTION_CHANNEL_ID
      ?? DEFAULT_NRT_REACTION_CHANNEL_ID,
  ).trim()
  const targetGuildId = String(options.guildId ?? '').trim() || null
  const excludeSelfReactions = options.excludeSelfReactions !== false

  async function awardGuessingGameWin(context = {}) {
    const gameType = String(context.gameType ?? '').trim().toLowerCase()
    const userId = String(context.userId ?? context.message?.author?.id ?? '').trim()
    const sourceMessageId = String(context.sourceMessageId ?? context.message?.id ?? '').trim()
    const guildId = String(context.guildId ?? context.game?.guildId ?? context.message?.guildId ?? '').trim()
    const channelId = String(context.channelId ?? context.game?.channelId ?? context.message?.channelId ?? '').trim()
    const gameId = String(context.gameId ?? context.game?.gameId ?? '').trim() || null

    try {
      if (!GAME_TYPES.has(gameType)) throw new Error('Unknown guessing-game type.')
      if (targetGuildId && guildId !== targetGuildId) {
        return {
          status: 'ignored',
          amount: GUESS_WIN_NRT,
          gameType,
          userId,
          sourceMessageId,
          reason: 'wrong_guild',
        }
      }
      const result = await store.awardOnce({
        idempotencyKey: guessWinAwardKey(gameType, sourceMessageId),
        awardType: 'guess_win',
        userId: requiredId(userId, 'userId'),
        amount: GUESS_WIN_NRT,
        guildId: requiredId(guildId, 'guildId'),
        channelId: requiredId(channelId, 'channelId'),
        sourceMessageId: requiredId(sourceMessageId, 'sourceMessageId'),
        gameType,
        metadata: gameId ? { game_id: gameId } : {},
      })
      return { ...result, gameType, userId, sourceMessageId }
    } catch (reason) {
      report(options, 'nrt_guess_win_award', reason, { gameType, userId, sourceMessageId, gameId })
      return {
        status: 'error',
        amount: GUESS_WIN_NRT,
        gameType,
        userId,
        sourceMessageId,
        reason: errorText(reason),
      }
    }
  }

  async function handleReactionAdd(reaction, user) {
    let context = { userId: String(user?.id ?? ''), sourceMessageId: null }
    try {
      const resolved = await resolveReactionEvent(reaction, user)
      const message = resolved.message
      const reactor = resolved.user
      const userId = String(reactor?.id ?? '').trim()
      const sourceMessageId = String(message?.id ?? '').trim()
      context = { userId, sourceMessageId }

      if (!userId || reactor?.bot) return { status: 'ignored', reason: 'bot_or_missing_user' }
      const guildId = String(message?.guildId ?? message?.guild?.id ?? '').trim()
      if (!guildId) return { status: 'ignored', reason: 'direct_message' }
      if (targetGuildId && guildId !== targetGuildId) return { status: 'ignored', reason: 'wrong_guild' }
      if (!targetChannelId || !isTargetChannel(message, targetChannelId)) {
        return { status: 'ignored', reason: 'wrong_channel' }
      }
      if (excludeSelfReactions && String(message?.author?.id ?? '') === userId) {
        return { status: 'ignored', reason: 'self_reaction' }
      }

      const channelId = String(message?.channelId ?? message?.channel?.id ?? '').trim()
      const emoji = resolved.reaction?.emoji
      const emojiIdentifier = String(emoji?.id ?? emoji?.name ?? '').trim() || null
      const result = await store.awardOnce({
        idempotencyKey: postReactionAwardKey(sourceMessageId, userId),
        awardType: 'post_reaction',
        userId,
        amount: POST_REACTION_NRT,
        guildId,
        channelId: requiredId(channelId, 'channelId'),
        sourceMessageId: requiredId(sourceMessageId, 'sourceMessageId'),
        gameType: null,
        metadata: {
          target_channel_id: targetChannelId,
          channel_parent_id: message?.channel?.parentId ?? null,
          message_author_id: message?.author?.id ?? null,
          first_observed_emoji: emojiIdentifier,
        },
      })
      return { ...result, userId, sourceMessageId }
    } catch (reason) {
      report(options, 'nrt_post_reaction_award', reason, context)
      return {
        status: 'error',
        amount: POST_REACTION_NRT,
        ...context,
        reason: errorText(reason),
      }
    }
  }

  return {
    awardGuessingGameWin,
    handleReactionAdd,
    targetChannelId,
    targetGuildId,
    excludeSelfReactions,
  }
}

export function installNrtRewardsWorkflow(client, options = {}) {
  const workflow = createNrtRewardsWorkflow(options)
  client.on(Events.MessageReactionAdd, (reaction, user) => {
    workflow.handleReactionAdd(reaction, user).catch((reason) => {
      report(options, 'nrt_post_reaction_listener', reason, {
        userId: user?.id ?? null,
        sourceMessageId: reaction?.message?.id ?? null,
      })
    })
  })
  return workflow
}
