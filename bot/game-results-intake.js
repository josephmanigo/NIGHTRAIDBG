import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  MessageFlags,
} from 'discord.js'
import { createSupabaseGameResultsStore } from './game-results-store.js'
import { resolveGameResultsConfig } from './game-results-config.js'
import {
  createSlidingWindowRateLimiter,
  createStructuredLogger,
} from './game-results-runtime.js'
import { hashDiscordAttachment } from './image-hash.js'

export const DEFAULT_GAME_RESULTS_CHANNEL_ID = '1532004107404050534'
export const DEFAULT_GAME_RESULTS_MAX_FILE_SIZE_MB = 10

const SUPPORTED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp'])
const SUPPORTED_CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp'])
const ROUND_BUTTON_PATTERN = /^nr-game-results-round:(\d{16,22}):([1-4])$/
const DISCORD_MESSAGE_LIMIT = 2_000

function configuredRoleIds(value) {
  if (value instanceof Set) return new Set(value)
  if (Array.isArray(value)) return new Set(value.map(String).map((item) => item.trim()).filter(Boolean))
  return new Set(
    String(value ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  )
}

export function gameResultsMaxFileSizeBytes(value) {
  const configured = value === undefined || value === null || value === ''
    ? DEFAULT_GAME_RESULTS_MAX_FILE_SIZE_MB
    : Number(value)
  if (!Number.isFinite(configured) || configured <= 0) {
    throw new Error('GAME_RESULTS_MAX_FILE_SIZE_MB must be a positive number.')
  }
  return Math.floor(configured * 1024 * 1024)
}

function filenameExtension(filename) {
  const match = /\.[^.]+$/.exec(String(filename ?? '').toLowerCase())
  return match?.[0] ?? ''
}

function displayFilename(filename) {
  return String(filename ?? 'unnamed attachment')
    .replace(/[\r\n`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) || 'unnamed attachment'
}

function displayFileSize(bytes) {
  const megabytes = Number(bytes) / (1024 * 1024)
  return `${megabytes.toFixed(megabytes >= 10 ? 1 : 2)} MB`
}

function limitDiscordContent(value) {
  if (value.length <= DISCORD_MESSAGE_LIMIT) return value
  return `${value.slice(0, DISCORD_MESSAGE_LIMIT - 14).trimEnd()}\n*...truncated*`
}

export function validateGameResultAttachments(attachments, maxFileSizeBytes) {
  const accepted = []
  const rejected = []

  for (const attachment of attachments) {
    const filename = displayFilename(attachment.name)
    const extension = filenameExtension(attachment.name)
    const contentType = String(attachment.contentType ?? '')
      .split(';', 1)[0]
      .trim()
      .toLowerCase()
    const supportedType =
      SUPPORTED_EXTENSIONS.has(extension)
      && (!contentType || SUPPORTED_CONTENT_TYPES.has(contentType))

    if (!supportedType) {
      rejected.push({
        attachment,
        reason: `\`${filename}\` is not a supported PNG, JPG, JPEG, or WEBP image.`,
      })
      continue
    }

    if (!Number.isFinite(attachment.size) || attachment.size < 0) {
      rejected.push({
        attachment,
        reason: `\`${filename}\` has no valid file size and cannot be accepted safely.`,
      })
      continue
    }

    if (attachment.size > maxFileSizeBytes) {
      rejected.push({
        attachment,
        reason:
          `\`${filename}\` is ${displayFileSize(attachment.size)}; `
          + `the limit is ${displayFileSize(maxFileSizeBytes)}.`,
      })
      continue
    }

    accepted.push(attachment)
  }

  return { accepted, rejected }
}

export function memberHasGameResultsRole(member, authorizedRoleIds) {
  if (!member || authorizedRoleIds.size === 0) return false
  const roleCache = member.roles?.cache
  if (roleCache?.has) {
    return [...authorizedRoleIds].some((roleId) => roleCache.has(roleId))
  }
  if (Array.isArray(member.roles)) {
    return member.roles.some((roleId) => authorizedRoleIds.has(String(roleId)))
  }
  return false
}

export function roundButtonCustomId(messageId, round) {
  return `nr-game-results-round:${messageId}:${round}`
}

export function parseRoundButtonCustomId(value) {
  const match = ROUND_BUTTON_PATTERN.exec(value ?? '')
  return match ? { messageId: match[1], round: Number(match[2]) } : null
}

export function parseRoundLabel(content) {
  const matches = [...String(content ?? '').matchAll(/\bROUND\s*([0-9]+)\b/gi)]
  if (matches.length !== 1) return null
  const round = Number(matches[0][1])
  return Number.isInteger(round) && round >= 1 && round <= 4 ? round : null
}

function roundButtons(messageId) {
  return new ActionRowBuilder().addComponents(
    [1, 2, 3, 4].map((round) =>
      new ButtonBuilder()
        .setCustomId(roundButtonCustomId(messageId, round))
        .setLabel(`Round ${round}`)
        .setStyle(ButtonStyle.Primary),
    ),
  )
}

function submissionTimestamp(message) {
  if (message.createdAt instanceof Date) return message.createdAt.toISOString()
  const timestamp = Number(message.createdTimestamp)
  return new Date(Number.isFinite(timestamp) ? timestamp : Date.now()).toISOString()
}

export function createGameResultRecords(message, attachments) {
  const timestamp = submissionTimestamp(message)
  return attachments.map((attachment) => ({
    guildId: message.guildId,
    channelId: message.channelId,
    messageId: message.id,
    attachmentId: attachment.id,
    attachmentFilename: attachment.name,
    attachmentUrl: attachment.url,
    discordUserId: message.author.id,
    submissionTimestamp: timestamp,
  }))
}

async function messageMember(message) {
  if (message.member) return message.member
  return message.guild?.members?.fetch
    ? message.guild.members.fetch(message.author.id).catch(() => null)
    : null
}

async function interactionMember(interaction) {
  if (interaction.member?.roles?.cache || Array.isArray(interaction.member?.roles)) {
    return interaction.member
  }
  return interaction.guild?.members?.fetch
    ? interaction.guild.members.fetch(interaction.user.id).catch(() => null)
    : null
}

function logRecord(logger, level, label, payload) {
  const output = logger?.[level] ?? logger?.log
  output?.call(logger, label, payload)
}

async function ephemeralReply(interaction, content) {
  const payload = {
    content,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  }
  if (interaction.replied || interaction.deferred) {
    const { flags: _flags, ...editPayload } = payload
    return interaction.editReply(editPayload)
  }
  return interaction.reply(payload)
}

export function createGameResultsIntake(options = {}) {
  const runtimeConfig = options.runtimeConfig ?? resolveGameResultsConfig()
  const channelId =
    options.channelId
    ?? process.env.GAME_RESULTS_CHANNEL_ID?.trim()
    ?? runtimeConfig.gameResultsChannelId
  const maxFileSizeBytes =
    options.maxFileSizeBytes
    ?? gameResultsMaxFileSizeBytes(
      process.env.MAX_IMAGE_SIZE_MB
      ?? process.env.GAME_RESULTS_MAX_FILE_SIZE_MB
      ?? runtimeConfig.maxImageSizeMb,
    )
  const authorizedRoleIds = configuredRoleIds(
    options.authorizedRoleIds
    ?? (runtimeConfig.authorizedRoleIds.size > 0
      ? runtimeConfig.authorizedRoleIds
      : process.env.GAME_RESULTS_SUBMITTER_ROLE_IDS),
  )
  const logger = options.logger ?? createStructuredLogger()
  const store = options.store ?? createSupabaseGameResultsStore()
  const hashAttachment = options.hashAttachment ?? hashDiscordAttachment
  const onOfficialSubmission = options.onOfficialSubmission
  const allowLegacyRoundSelection = options.allowLegacyRoundSelection === true
  const pendingSubmissions = new Map()
  const officialSubmissions = new Map()
  const deletedMessageIds = new Set()
  const rateLimiter =
    options.rateLimiter
    ?? createSlidingWindowRateLimiter({
      limit: options.rateLimit ?? 5,
      windowMs: options.rateLimitWindowMs ?? 60_000,
    })
  let initializationPromise

  function initialize() {
    initializationPromise ??= Promise.resolve().then(() => store.initialize())
    return initializationPromise
  }

  function rememberDeletedMessage(messageId) {
    deletedMessageIds.add(messageId)
    const expiryTimer = setTimeout(() => deletedMessageIds.delete(messageId), 15 * 60 * 1_000)
    expiryTimer.unref()
  }

  async function replyWithRoundSelection(message, submission, duplicateCount = 0) {
    const duplicateNotice =
      duplicateCount > 0
        ? `\n${duplicateCount} exact duplicate screenshot${duplicateCount === 1 ? ' was' : 's were'} blocked.`
        : ''
    await message.reply({
      content: [
        '# Game-result screenshots stored',
        `${submission.records.length} screenshot${submission.records.length === 1 ? '' : 's'} passed intake and hashing.${duplicateNotice}`,
        '',
        '**Select the round for this official submission:**',
      ].join('\n'),
      components: [roundButtons(message.id)],
      allowedMentions: { parse: [], repliedUser: true },
    })
  }

  async function recordLabeledRound(message, submission, round, duplicateCount = 0) {
    const officialSubmission = await store.selectRound({
      submissionId: submission.submissionId,
      discordUserId: submission.discordUserId,
      round,
    })
    pendingSubmissions.delete(message.id)
    officialSubmissions.set(message.id, officialSubmission)
    const duplicateNotice =
      duplicateCount > 0
        ? ` ${duplicateCount} exact duplicate screenshot${duplicateCount === 1 ? ' was' : 's were'} skipped.`
        : ''
    await message.reply({
      content: [
        `# Round ${round} automatic tally started`,
        `${officialSubmission.records.length} screenshot${officialSubmission.records.length === 1 ? '' : 's'} will be processed now.${duplicateNotice}`,
        onOfficialSubmission
          ? `Results will be written automatically when validation passes.`
          : 'Automatic score processing is not installed.',
      ].join('\n'),
      allowedMentions: { parse: [], repliedUser: true },
    })
    logRecord(logger, 'info', 'GAME_RESULTS_LABELED_ROUND_SUBMISSION', officialSubmission)
    const review = onOfficialSubmission
      ? await onOfficialSubmission(officialSubmission, {
          guildId: message.guildId,
          channelId: message.channelId,
          client: message.client,
          channel: message.channel,
          user: message.author,
          member: message.member,
          followUp: (payload) => message.reply(payload),
        })
      : null
    return {
      status: 'automatic',
      submission: officialSubmission,
      review,
      duplicates: duplicateCount,
    }
  }

  async function handleMessage(message) {
    if (message.author?.bot || message.channelId !== channelId || !message.inGuild?.()) {
      return { status: 'ignored' }
    }
    if (deletedMessageIds.has(message.id)) return { status: 'deleted' }

    const attachments = [...(message.attachments?.values?.() ?? [])]
    if (attachments.length === 0) return { status: 'ignored' }
    const labeledRound = parseRoundLabel(message.content)

    const validation = validateGameResultAttachments(attachments, maxFileSizeBytes)
    if (validation.rejected.length > 0) {
      const reasons = validation.rejected.map(({ reason }) => `- ${reason}`)
      await message.reply({
        content: limitDiscordContent([
          '# Screenshot submission rejected',
          'No screenshots from this message were accepted.',
          '',
          ...reasons,
        ].join('\n')),
        allowedMentions: { parse: [], repliedUser: true },
      })
      return { status: 'rejected', rejected: validation.rejected }
    }

    const member = await messageMember(message)
    if (!memberHasGameResultsRole(member, authorizedRoleIds)) {
      await message.reply({
        content:
          '# Screenshot submission not authorized\n'
          + 'You do not have a role configured for official game-result submissions.',
        allowedMentions: { parse: [], repliedUser: true },
      })
      return { status: 'unauthorized' }
    }
    const rateLimit = rateLimiter.consume(`${message.guildId}:${message.author.id}`)
    if (!rateLimit.allowed) {
      const retrySeconds = Math.max(1, Math.ceil(rateLimit.retryAfterMs / 1_000))
      await message.reply({
        content:
          '# Screenshot submission rate limited\n'
          + `Try again in approximately ${retrySeconds} second${retrySeconds === 1 ? '' : 's'}.`,
        allowedMentions: { parse: [], repliedUser: true },
      })
      logRecord(logger, 'warn', 'GAME_RESULTS_RATE_LIMITED', {
        guild_id: message.guildId,
        user_id: message.author.id,
        retry_after_seconds: retrySeconds,
      })
      return { status: 'rate_limited', retryAfterSeconds: retrySeconds }
    }
    if (!labeledRound && !allowLegacyRoundSelection) {
      await message.reply({
        content:
          '# Round label required\n'
          + 'Send the screenshot again with exactly one label: `ROUND 1`, `ROUND 2`, `ROUND 3`, or `ROUND 4`.',
        allowedMentions: { parse: [], repliedUser: true },
      })
      return { status: 'missing_round_label' }
    }

    const baseRecords = createGameResultRecords(message, validation.accepted)
    const metadata = {
      guildId: message.guildId,
      channelId: message.channelId,
      messageId: message.id,
      discordUserId: message.author.id,
      submissionTimestamp: baseRecords[0].submissionTimestamp,
    }

    try {
      await initialize()
      if (deletedMessageIds.has(message.id)) return { status: 'deleted' }
      const existing = await store.findSubmissionByMessage(metadata)
      if (deletedMessageIds.has(message.id)) {
        if (existing) await store.tombstoneDeletedMessage(metadata)
        return { status: 'deleted' }
      }
      if (existing) {
        if (existing.status === 'duplicate') {
          await message.reply({
            content:
              '# Duplicate screenshot submission\n'
              + 'Every screenshot in this message matches an exact file already stored.',
            allowedMentions: { parse: [], repliedUser: true },
          })
          return { status: 'duplicate', submission: existing }
        }
        if (existing.round) {
          await message.reply({
            content: `This submission is already stored for **Round ${existing.round}**.`,
            allowedMentions: { parse: [], repliedUser: true },
          })
          officialSubmissions.set(message.id, existing)
          return { status: 'already_recorded', submission: existing }
        }
        if (labeledRound) {
          return recordLabeledRound(message, existing, labeledRound)
        }
        pendingSubmissions.set(message.id, existing)
        await replyWithRoundSelection(message, existing)
        return { status: 'pending_round', submission: existing }
      }

      const hashedRecords = []
      for (let index = 0; index < validation.accepted.length; index += 1) {
        const hashes = await hashAttachment(validation.accepted[index], { maxFileSizeBytes })
        hashedRecords.push({ ...baseRecords[index], ...hashes })
      }
      if (deletedMessageIds.has(message.id)) return { status: 'deleted' }
      const stored = await store.createPendingSubmission(metadata, hashedRecords)
      if (deletedMessageIds.has(message.id)) {
        await store.tombstoneDeletedMessage(metadata)
        return { status: 'deleted' }
      }
      const submission = stored.submission
      if (!submission) throw new Error('Persistent storage did not return the screenshot submission.')

      if (submission.status === 'duplicate' || submission.records.length === 0) {
        await message.reply({
          content:
            '# Duplicate screenshot submission\n'
            + 'Every screenshot in this message matches an exact file already stored.',
          allowedMentions: { parse: [], repliedUser: true },
        })
        logRecord(logger, 'warn', 'GAME_RESULTS_EXACT_DUPLICATE_BLOCKED', {
          submission,
          duplicates: stored.duplicates,
        })
        return { status: 'duplicate', submission, duplicates: stored.duplicates }
      }

      if (labeledRound) {
        return recordLabeledRound(
          message,
          submission,
          labeledRound,
          stored.duplicates.length,
        )
      }
      pendingSubmissions.set(message.id, submission)
      await replyWithRoundSelection(message, submission, stored.duplicates.length)
      logRecord(logger, 'info', 'GAME_RESULTS_INTAKE_PENDING', {
        submission,
        duplicates: stored.duplicates,
      })
      return { status: 'pending_round', submission, duplicates: stored.duplicates }
    } catch (reason) {
      pendingSubmissions.delete(message.id)
      logRecord(logger, 'error', 'GAME_RESULTS_STORAGE_FAILED', {
        ...metadata,
        error: reason instanceof Error ? reason.message : String(reason),
      })
      await message.reply({
        content:
          '# Screenshot storage failed\n'
          + 'The screenshots could not be stored safely. Nothing will be processed from this message.',
        allowedMentions: { parse: [], repliedUser: true },
      })
      return { status: 'failed', reason }
    }
  }

  async function handleInteraction(interaction) {
    if (!interaction.isButton?.()) return { status: 'ignored' }
    const selection = parseRoundButtonCustomId(interaction.customId)
    if (!selection) return { status: 'ignored' }
    if (interaction.channelId !== channelId) {
      await ephemeralReply(interaction, 'This round selector is not in the configured game-results channel.')
      return { status: 'wrong_channel' }
    }

    await initialize()
    if (deletedMessageIds.has(selection.messageId)) {
      await ephemeralReply(interaction, 'This screenshot message was deleted and cannot be submitted.')
      return { status: 'deleted' }
    }
    const submission =
      pendingSubmissions.get(selection.messageId)
      ?? await store.findSubmissionByMessage({
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        messageId: selection.messageId,
      })
    if (!submission) {
      await ephemeralReply(interaction, 'This screenshot submission is no longer awaiting a round selection.')
      return { status: 'not_pending' }
    }
    if (submission.status !== 'pending') {
      await ephemeralReply(interaction, `This screenshot submission is already marked ${submission.status}.`)
      return { status: 'not_pending' }
    }
    if (submission.round) {
      await ephemeralReply(interaction, `This submission is already stored for Round ${submission.round}.`)
      return { status: 'already_recorded', submission }
    }
    if (interaction.user.id !== submission.discordUserId) {
      await ephemeralReply(interaction, 'Only the screenshot uploader can select its round.')
      return { status: 'wrong_user' }
    }

    const member = await interactionMember(interaction)
    if (!memberHasGameResultsRole(member, authorizedRoleIds)) {
      await ephemeralReply(interaction, 'You are not authorized to make an official game-result submission.')
      return { status: 'unauthorized' }
    }

    const officialSubmission = await store.selectRound({
      submissionId: submission.submissionId,
      discordUserId: submission.discordUserId,
      round: selection.round,
    })
    pendingSubmissions.delete(selection.messageId)
    officialSubmissions.set(selection.messageId, officialSubmission)

    await interaction.update({
      content: [
        `# Round ${selection.round} submission recorded`,
        `${officialSubmission.records.length} screenshot${officialSubmission.records.length === 1 ? '' : 's'} are stored with status **pending**.`,
        onOfficialSubmission
          ? '-# Processing screenshots for persistent review. No Google Sheets write will occur.'
          : '-# Persistent review processing is not installed.',
      ].join('\n'),
      components: [],
      allowedMentions: { parse: [] },
    })
    logRecord(logger, 'info', 'GAME_RESULTS_OFFICIAL_SUBMISSION', officialSubmission)
    const review = onOfficialSubmission
      ? await onOfficialSubmission(officialSubmission, interaction)
      : null
    return { status: 'official', submission: officialSubmission, review }
  }

  async function handleMessageDelete(message) {
    if (message.channelId !== channelId || !message.guildId || !message.id) {
      return { status: 'ignored' }
    }
    if (deletedMessageIds.has(message.id)) return { status: 'already_deleted' }

    rememberDeletedMessage(message.id)
    await initialize()
    const deletion = await store.tombstoneDeletedMessage({
      guildId: message.guildId,
      channelId: message.channelId,
      messageId: message.id,
    })
    pendingSubmissions.delete(message.id)
    officialSubmissions.delete(message.id)

    if (!deletion.found) return { status: 'not_found' }

    logRecord(logger, 'info', 'GAME_RESULTS_DISCORD_SOURCE_DELETED', {
      guild_id: message.guildId,
      channel_id: message.channelId,
      message_id: message.id,
      submission_id: deletion.submission_id ?? null,
      previous_status: deletion.previous_status ?? null,
      current_status: deletion.current_status ?? null,
      screenshots_removed: deletion.screenshots_removed ?? 0,
    })
    return { status: 'deleted', deletion }
  }

  async function recoverPendingSubmissions(client) {
    await initialize()
    if (!store.listRecoverableSubmissions) {
      return { recovered: 0, resumed: 0, failed: 0 }
    }
    const submissions = await store.listRecoverableSubmissions()
    const latestTimedOutAutomaticSubmission = new Map()
    for (const submission of submissions) {
      const timedOut = (
        submission.status === 'failed'
        && submission.reviewPayload?.automatic_tally === true
        && (submission.reviewPayload?.issues ?? []).some((issue) =>
          issue?.severity === 'blocking'
          && String(issue?.message ?? '').includes('Local OCR worker timed out after'))
      )
      if (!timedOut) continue
      latestTimedOutAutomaticSubmission.set(
        `${submission.guildId}:${submission.channelId}:${submission.round}`,
        submission.submissionId,
      )
    }
    let recovered = 0
    let resumed = 0
    let failed = 0
    for (const submission of submissions) {
      if (!submission.round) {
        pendingSubmissions.set(submission.messageId, submission)
        recovered += 1
        continue
      }
      officialSubmissions.set(submission.messageId, submission)
      const approvedAutomaticRetry = (
        submission.status === 'approved_for_writing'
        && submission.reviewPayload?.automatic_tally === true
        && submission.reviewPayload?.blocking_issue_count === 0
        && submission.reviewPayload?.spreadsheet_write_performed !== true
      )
      const timeoutRecoveryCount = Number(
        submission.reviewPayload?.startup_timeout_retry_count ?? 0,
      )
      const timedOutAutomaticRetry = (
        submission.status === 'failed'
        && submission.reviewPayload?.automatic_tally === true
        && Number.isInteger(timeoutRecoveryCount)
        && timeoutRecoveryCount < 1
        && latestTimedOutAutomaticSubmission.get(
          `${submission.guildId}:${submission.channelId}:${submission.round}`,
        ) === submission.submissionId
        && (submission.reviewPayload?.issues ?? []).some((issue) =>
          issue?.severity === 'blocking'
          && String(issue?.message ?? '').includes('Local OCR worker timed out after'))
      )
      if (
        !onOfficialSubmission
        || (
          !approvedAutomaticRetry
          && !timedOutAutomaticRetry
          && (
            submission.reviewPayload
            || !['pending', 'processing', 'failed'].includes(submission.status)
          )
        )
      ) continue
      try {
        let resumableSubmission = submission
        if (timedOutAutomaticRetry) {
          if (!store.saveReviewState) {
            throw new Error('Timed-out OCR recovery cannot persist its retry marker.')
          }
          resumableSubmission = await store.saveReviewState({
            submissionId: submission.submissionId,
            payload: {
              ...submission.reviewPayload,
              startup_timeout_retry_count: timeoutRecoveryCount + 1,
              startup_timeout_retry_at: new Date().toISOString(),
            },
            page: submission.reviewPage ?? 0,
            status: 'failed',
            updatedBy: submission.discordUserId,
            expectedVersion: submission.reviewVersion ?? 0,
          })
        }
        const channel = await client.channels.fetch(submission.channelId)
        if (!channel?.send) throw new Error('Recovery channel is unavailable.')
        await onOfficialSubmission(resumableSubmission, {
          guildId: submission.guildId,
          channelId: submission.channelId,
          client,
          channel,
          followUp: (payload) => channel.send(payload),
        })
        resumed += 1
      } catch (reason) {
        failed += 1
        logRecord(logger, 'error', 'GAME_RESULTS_STARTUP_RECOVERY_FAILED', {
          submission_id: submission.submissionId,
          error: reason,
        })
      }
    }
    logRecord(logger, 'info', 'GAME_RESULTS_STARTUP_RECOVERY', {
      found: submissions.length,
      recovered,
      resumed,
      failed,
    })
    return { recovered, resumed, failed }
  }

  return {
    channelId,
    maxFileSizeBytes,
    authorizedRoleIds,
    initialize,
    handleMessage,
    handleMessageDelete,
    handleInteraction,
    recoverPendingSubmissions,
    getPendingSubmission: (messageId) => pendingSubmissions.get(messageId) ?? null,
    getOfficialSubmission: (messageId) => officialSubmissions.get(messageId) ?? null,
  }
}

export function installGameResultsIntake(client, options = {}) {
  const intake = createGameResultsIntake(options)
  if (intake.authorizedRoleIds.size === 0) {
    console.warn(
      'Game-results intake is fail-closed: GAME_RESULTS_SUBMITTER_ROLE_IDS has no configured roles.',
    )
  }
  intake.initialize()
    .then(() => (options.logger ?? console).info?.(
      'GAME_RESULTS_STORAGE_READY',
      { channel_id: intake.channelId },
    ))
    .catch((reason) => {
      options.errorReporter?.report(
        'game_results_storage_initialization',
        reason,
      )
      if (!options.errorReporter) {
        console.error(
          'Persistent game-results storage initialization failed:',
          reason instanceof Error ? reason.message : reason,
        )
      }
    })

  client.on(Events.MessageCreate, (message) => {
    intake.handleMessage(message).catch((reason) => {
      options.errorReporter?.report('game_results_screenshot_intake', reason)
      if (!options.errorReporter) {
        console.error(
          'Game-results screenshot intake failed:',
          reason instanceof Error ? reason.message : reason,
        )
      }
    })
  })

  const handleDeletedMessage = (message) => {
    intake.handleMessageDelete(message).catch((reason) => {
      options.errorReporter?.report('game_results_screenshot_deletion', reason)
      if (!options.errorReporter) {
        console.error(
          'Game-results screenshot deletion failed:',
          reason instanceof Error ? reason.message : reason,
        )
      }
    })
  }

  client.on(Events.MessageDelete, handleDeletedMessage)
  client.on(Events.MessageBulkDelete, (messages) => {
    for (const message of messages.values()) handleDeletedMessage(message)
  })

  client.on(Events.InteractionCreate, (interaction) => {
    intake.handleInteraction(interaction).catch((reason) => {
      options.errorReporter?.report('game_results_round_selection', reason)
      if (!options.errorReporter) {
        console.error(
          'Game-results round selection failed:',
          reason instanceof Error ? reason.message : reason,
        )
      }
    })
  })
  client.once(Events.ClientReady, () => {
    intake.recoverPendingSubmissions(client).catch((reason) => {
      options.errorReporter?.report(
        'game_results_startup_recovery',
        reason,
      )
    })
  })

  return intake
}
