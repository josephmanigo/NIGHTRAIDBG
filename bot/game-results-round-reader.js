import { z } from 'zod'
import { createSingleScreenshotReader } from './game-results-reader.js'
import { fetchWithRetry } from './game-results-runtime.js'

const DEFAULT_MAX_FILE_SIZE_MB = 10
const EXPECTED_PLAYERS_PER_TEAM = 4
const SUPPORTED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp'])

const mergedPlayerSchema = z
  .object({
    slot: z.string().min(1).max(100).nullable(),
    name: z.string().min(1).max(100).nullable(),
    kills: z.number().int().nonnegative().nullable(),
    confidence: z.object({
      slot: z.number().min(0).max(1),
      name: z.number().min(0).max(1),
      kills: z.number().min(0).max(1),
    }),
  })
  .passthrough()

const screenshotResultSchema = z
  .object({
    source: z.object({
      original_sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    }).passthrough(),
    teams: z.array(
      z.object({
        rank: z.number().int().positive().nullable(),
        team_code: z.string().min(1).max(100).nullable(),
        team_total_kills: z.number().int().nonnegative().nullable(),
        confidence: z.object({
          rank: z.number().min(0).max(1),
          team_code: z.number().min(0).max(1),
          team_total_kills: z.number().min(0).max(1),
        }),
        players: z.array(mergedPlayerSchema).max(8),
      }).passthrough(),
    ).max(30),
  })
  .passthrough()

function configuredMaxFileSizeBytes(value) {
  const megabytes = value === undefined || value === null || value === ''
    ? DEFAULT_MAX_FILE_SIZE_MB
    : Number(value)
  if (!Number.isFinite(megabytes) || megabytes <= 0) {
    throw new Error('GAME_RESULTS_MAX_FILE_SIZE_MB must be a positive number.')
  }
  return Math.floor(megabytes * 1024 * 1024)
}

function filenameMimeType(filename) {
  const extension = /\.[^.]+$/.exec(String(filename ?? '').toLowerCase())?.[0]
  if (extension === '.png') return 'image/png'
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg'
  if (extension === '.webp') return 'image/webp'
  return null
}

export async function downloadSubmissionScreenshot(record, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const maxFileSizeBytes =
    options.maxFileSizeBytes
    ?? configuredMaxFileSizeBytes(
      process.env.MAX_IMAGE_SIZE_MB
      ?? process.env.GAME_RESULTS_MAX_FILE_SIZE_MB,
    )
  if (!record?.attachmentUrl) throw new Error('Stored screenshot has no attachment URL.')
  const response = await fetchWithRetry(record.attachmentUrl, {}, {
    fetchImpl,
    timeoutMs: options.timeoutMs ?? 15_000,
    maxRetries:
      options.maxRetries
      ?? Number(process.env.GAME_RESULTS_NETWORK_RETRIES || 3),
  })
  if (!response.ok) throw new Error(`Screenshot download failed with status ${response.status}.`)

  const declaredSize = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredSize) && declaredSize > maxFileSizeBytes) {
    throw new Error('Stored screenshot exceeds the configured file-size limit.')
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length === 0) throw new Error('Stored screenshot download was empty.')
  if (buffer.length > maxFileSizeBytes) {
    throw new Error('Stored screenshot exceeds the configured file-size limit.')
  }
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim()?.toLowerCase()
  const mimeType = SUPPORTED_MIME_TYPES.has(contentType)
    ? contentType
    : filenameMimeType(record.attachmentFilename)
  if (!mimeType) throw new Error('Stored screenshot has no supported image type.')
  return { buffer, mimeType }
}

function exactValueKey(value) {
  if (typeof value === 'string') return `string:${value.normalize('NFKC')}`
  return `${typeof value}:${JSON.stringify(value)}`
}

function identityText(value) {
  if (typeof value !== 'string') return null
  const normalized = value.normalize('NFKC').trim()
  return normalized ? normalized.toLocaleUpperCase('en-US') : null
}

function playerSlots(team) {
  return new Set(team.players.map((player) => identityText(player.slot)).filter(Boolean))
}

function playerNames(team) {
  return new Set(team.players.map((player) => identityText(player.name)).filter(Boolean))
}

function setsOverlap(left, right) {
  for (const value of left) {
    if (right.has(value)) return true
  }
  return false
}

function sameTeamObservation(left, right) {
  const leftCode = identityText(left.team.team_code)
  const rightCode = identityText(right.team.team_code)
  if (leftCode && rightCode && leftCode !== rightCode) return false
  if (
    left.team.rank !== null
    && right.team.rank !== null
    && left.team.rank !== right.team.rank
  ) return false
  if (leftCode && rightCode && leftCode === rightCode) return true
  if (left.team.rank !== null && left.team.rank === right.team.rank) return true
  if (setsOverlap(playerSlots(left.team), playerSlots(right.team))) return true

  const leftNames = playerNames(left.team)
  const rightNames = playerNames(right.team)
  if (leftNames.size >= 2 && rightNames.size >= 2) {
    let matches = 0
    for (const name of leftNames) if (rightNames.has(name)) matches += 1
    if (matches >= 2) return true
  }
  return false
}

function dominantContiguousRankSet(teams) {
  const ranks = [...new Set(
    teams
      .map((team) => team.rank)
      .filter((rank) => Number.isInteger(rank) && rank > 0),
  )].sort((left, right) => left - right)
  if (ranks.length < 5) return null

  let best = []
  let current = []
  for (const rank of ranks) {
    if (current.length === 0 || rank === current.at(-1) + 1) current.push(rank)
    else current = [rank]
    if (current.length > best.length) best = [...current]
  }
  if (best.length < 4 || best.length / ranks.length < 0.75) return null
  return new Set(best)
}

function filterRankOutliers(teams) {
  const dominantRanks = dominantContiguousRankSet(teams)
  if (!dominantRanks) return { teams, ignored: [] }
  const ignored = []
  const kept = teams.filter((team, teamIndex) => {
    if (!Number.isInteger(team.rank) || dominantRanks.has(team.rank)) return true
    ignored.push({
      team_index: teamIndex,
      rank: team.rank,
      team_code: team.team_code,
      team_total_kills: team.team_total_kills,
      reason: 'outside_dominant_contiguous_rank_sequence',
    })
    return false
  })
  return { teams: kept, ignored }
}

function disjointSet(size) {
  const parents = Array.from({ length: size }, (_value, index) => index)
  function find(index) {
    let current = index
    while (parents[current] !== current) {
      parents[current] = parents[parents[current]]
      current = parents[current]
    }
    return current
  }
  function union(left, right) {
    const leftRoot = find(left)
    const rightRoot = find(right)
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot
  }
  return { find, union }
}

function groupByIdentity(observations, matcher) {
  const groups = disjointSet(observations.length)
  for (let left = 0; left < observations.length; left += 1) {
    for (let right = left + 1; right < observations.length; right += 1) {
      if (matcher(observations[left], observations[right])) groups.union(left, right)
    }
  }
  const byRoot = new Map()
  observations.forEach((observation, index) => {
    const root = groups.find(index)
    const bucket = byRoot.get(root) ?? []
    bucket.push(observation)
    byRoot.set(root, bucket)
  })
  return [...byRoot.values()]
}

function sourceReference(observation) {
  return {
    screenshot_index: observation.source.screenshotIndex,
    attachment_id: observation.source.attachmentId,
    filename: observation.source.filename,
    team_index: observation.teamIndex,
    player_index: observation.playerIndex ?? null,
  }
}

function collectIdentityConflicts(observations, conflicts, reviewFields) {
  const seen = new Set()
  for (let leftIndex = 0; leftIndex < observations.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < observations.length; rightIndex += 1) {
      const left = observations[leftIndex]
      const right = observations[rightIndex]
      const leftCode = identityText(left.team.team_code)
      const rightCode = identityText(right.team.team_code)
      const sameRank =
        left.team.rank !== null
        && left.team.rank === right.team.rank
      const sameCode = leftCode && leftCode === rightCode
      if (
        (!sameRank || !leftCode || !rightCode || leftCode === rightCode)
        && (!sameCode || left.team.rank === null || right.team.rank === null
          || left.team.rank === right.team.rank)
      ) continue

      const field = sameRank
        ? `leaderboard.rank.${left.team.rank}`
        : `leaderboard.team_code.${leftCode}`
      const key = `${field}:${left.source.screenshotIndex}:${right.source.screenshotIndex}`
      if (seen.has(key)) continue
      seen.add(key)
      conflicts.push({
        type: 'team_identity_conflict',
        field,
        candidates: [left, right].map((item) => ({
          value: {
            rank: item.team.rank,
            team_code: item.team.team_code,
            team_total_kills: item.team.team_total_kills,
          },
          confidence: Math.min(
            item.team.confidence.rank,
            item.team.confidence.team_code,
          ),
          sources: [sourceReference(item)],
        })),
        requires_manual_review: true,
      })
      reviewFields.push(field)
    }
  }
}

function mergeField(observations, value, confidence) {
  const candidates = new Map()
  for (const observation of observations) {
    const observedValue = value(observation)
    if (observedValue === null || observedValue === undefined) continue
    const key = exactValueKey(observedValue)
    const item = candidates.get(key) ?? {
      value: observedValue,
      confidence: 0,
      sources: [],
    }
    const observedConfidence = Number(confidence(observation) ?? 0)
    if (observedConfidence > item.confidence) {
      item.value = observedValue
      item.confidence = observedConfidence
    }
    item.sources.push(sourceReference(observation))
    candidates.set(key, item)
  }
  const choices = [...candidates.values()].map((candidate) => ({
    ...candidate,
    confidence: Number(candidate.confidence.toFixed(3)),
  }))
  if (choices.length !== 1) {
    return {
      value: null,
      confidence: choices.length === 0 ? 0 : Math.max(...choices.map((item) => item.confidence)),
      choices,
      conflict: choices.length > 1,
    }
  }
  return {
    value: choices[0].value,
    confidence: choices[0].confidence,
    choices,
    conflict: false,
  }
}

function samePlayerObservation(left, right) {
  const leftSlot = identityText(left.player.slot)
  const rightSlot = identityText(right.player.slot)
  if (leftSlot && rightSlot && leftSlot === rightSlot) return true
  const leftName = identityText(left.player.name)
  const rightName = identityText(right.player.name)
  if (leftName && rightName && leftName === rightName) return true
  return (
    left.source.screenshotIndex !== right.source.screenshotIndex
    && left.playerIndex === right.playerIndex
  )
}

function mergePlayers(teamObservations) {
  const observations = teamObservations.flatMap((teamObservation) =>
    teamObservation.team.players.map((player, playerIndex) => ({
      player,
      playerIndex,
      teamIndex: teamObservation.teamIndex,
      source: teamObservation.source,
    })))
  return groupByIdentity(observations, samePlayerObservation).map((group) => ({
    slot: mergeField(
      group,
      (item) => item.player.slot,
      (item) => item.player.confidence.slot,
    ),
    name: mergeField(
      group,
      (item) => item.player.name,
      (item) => item.player.confidence.name,
    ),
    kills: mergeField(
      group,
      (item) => item.player.kills,
      (item) => item.player.confidence.kills,
    ),
    sources: group.map(sourceReference),
  }))
}

function sortableValue(value) {
  return value === null ? Number.POSITIVE_INFINITY : value
}

function sortablePlayer(player) {
  return player.slot.value ?? player.name.value ?? '\uffff'
}

function mergeTeams(observations) {
  return groupByIdentity(observations, sameTeamObservation)
    .map((group) => ({
      rank: mergeField(
        group,
        (item) => item.team.rank,
        (item) => item.team.confidence.rank,
      ),
      team_code: mergeField(
        group,
        (item) => item.team.team_code,
        (item) => item.team.confidence.team_code,
      ),
      team_total_kills: mergeField(
        group,
        (item) => item.team.team_total_kills,
        (item) => item.team.confidence.team_total_kills,
      ),
      players: mergePlayers(group).sort((left, right) =>
        sortablePlayer(left).localeCompare(sortablePlayer(right), 'en', { numeric: true })),
      sources: group.map(sourceReference),
    }))
    .sort((left, right) => {
      const rankDifference = sortableValue(left.rank.value) - sortableValue(right.rank.value)
      if (rankDifference !== 0) return rankDifference
      return String(left.team_code.value ?? '').localeCompare(String(right.team_code.value ?? ''))
    })
}

function fieldConflict(path, field) {
  if (!field.conflict) return null
  return {
    type: 'field_conflict',
    field: path,
    candidates: field.choices,
    requires_manual_review: true,
  }
}

function serializeMergedTeams(mergedTeams, conflicts, reviewFields) {
  return mergedTeams.map((team, teamIndex) => {
    const teamPath = `teams[${teamIndex}]`
    for (const [name, field] of [
      ['rank', team.rank],
      ['team_code', team.team_code],
      ['team_total_kills', team.team_total_kills],
    ]) {
      const path = `${teamPath}.${name}`
      const conflict = fieldConflict(path, field)
      if (conflict) conflicts.push(conflict)
      if (field.value === null) reviewFields.push(path)
    }

    const players = team.players.map((player, playerIndex) => {
      const playerPath = `${teamPath}.players[${playerIndex}]`
      for (const [name, field] of [
        ['slot', player.slot],
        ['name', player.name],
        ['kills', player.kills],
      ]) {
        const path = `${playerPath}.${name}`
        const conflict = fieldConflict(path, field)
        if (conflict) conflicts.push(conflict)
        if (field.value === null) reviewFields.push(path)
      }
      return {
        slot: player.slot.value,
        name: player.name.value,
        kills: player.kills.value,
        confidence: {
          slot: player.slot.confidence,
          name: player.name.confidence,
          kills: player.kills.confidence,
        },
        sources: player.sources,
      }
    })

    return {
      rank: team.rank.value,
      team_code: team.team_code.value,
      team_total_kills: team.team_total_kills.value,
      confidence: {
        rank: team.rank.confidence,
        team_code: team.team_code.confidence,
        team_total_kills: team.team_total_kills.confidence,
      },
      players,
      sources: team.sources,
    }
  })
}

function validatePlayerKillTotals(teams, conflicts, reviewFields) {
  return teams.map((team, teamIndex) => {
    const field = `teams[${teamIndex}].team_total_kills`
    const completeRoster = team.players.length === EXPECTED_PLAYERS_PER_TEAM
    const allPlayerKillsReadable =
      completeRoster
      && team.players.every((player) => player.kills !== null)
    if (team.team_total_kills === null || !allPlayerKillsReadable) {
      return {
        team_rank: team.rank,
        team_code: team.team_code,
        status: 'not_checkable',
        displayed_team_total: team.team_total_kills,
        calculated_player_total: null,
        complete_roster: completeRoster,
        all_player_kills_readable: allPlayerKillsReadable,
      }
    }

    const calculatedTotal = team.players.reduce((sum, player) => sum + player.kills, 0)
    if (calculatedTotal !== team.team_total_kills) {
      conflicts.push({
        type: 'kill_total_mismatch',
        field,
        displayed_team_total: team.team_total_kills,
        calculated_player_total: calculatedTotal,
        player_kills: team.players.map((player) => ({
          slot: player.slot,
          name: player.name,
          kills: player.kills,
        })),
        requires_manual_review: true,
      })
      reviewFields.push(field)
    }
    return {
      team_rank: team.rank,
      team_code: team.team_code,
      status: calculatedTotal === team.team_total_kills ? 'matched' : 'mismatch',
      displayed_team_total: team.team_total_kills,
      calculated_player_total: calculatedTotal,
      complete_roster: true,
      all_player_kills_readable: true,
    }
  })
}

function validateSubmission(submission) {
  if (!submission || typeof submission !== 'object') {
    throw new Error('A stored screenshot submission is required.')
  }
  if (!Number.isInteger(submission.round) || submission.round < 1 || submission.round > 4) {
    throw new Error('The screenshot submission must have a selected round from 1 to 4.')
  }
  if (!Array.isArray(submission.records) || submission.records.length === 0) {
    throw new Error('The screenshot submission has no canonical screenshots to read.')
  }
}

function safeError(reason) {
  return (reason instanceof Error ? reason.message : String(reason))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500)
}

export function createRoundSubmissionReader(options = {}) {
  const ownsSingleReader = !options.singleScreenshotReader
  const singleScreenshotReader =
    options.singleScreenshotReader
    ?? createSingleScreenshotReader(options.screenshotReader)
  const attachmentLoader =
    options.attachmentLoader
    ?? ((record) => downloadSubmissionScreenshot(record, options.download))

  async function readSubmission(submission, readOptions = {}) {
    validateSubmission(submission)
    const screenshotReads = []
    const readErrors = []
    const ignoredRows = []

    for (let screenshotIndex = 0; screenshotIndex < submission.records.length; screenshotIndex += 1) {
      const record = submission.records[screenshotIndex]
      try {
        const loaded = await attachmentLoader(record)
        const parsed = screenshotResultSchema.parse(await singleScreenshotReader.read({
          buffer: loaded.buffer,
          mimeType: loaded.mimeType,
          filename: record.attachmentFilename,
          scoreOnly: readOptions.scoreOnly === true,
        }))
        const filtered = filterRankOutliers(parsed.teams)
        const result = { ...parsed, teams: filtered.teams }
        ignoredRows.push(...filtered.ignored.map((row) => ({
          ...row,
          screenshot_index: screenshotIndex,
          attachment_id: record.attachmentId,
          filename: record.attachmentFilename,
        })))
        screenshotReads.push({ screenshotIndex, record, result })
        if (result.teams.length === 0) {
          readErrors.push({
            type: 'screenshot_no_rows',
            screenshot_index: screenshotIndex,
            attachment_id: record.attachmentId,
            filename: record.attachmentFilename,
            error: 'The screenshot reader returned no leaderboard rows.',
            requires_manual_review: true,
          })
        }
      } catch (reason) {
        readErrors.push({
          type: 'screenshot_read_failed',
          screenshot_index: screenshotIndex,
          attachment_id: record.attachmentId,
          filename: record.attachmentFilename,
          error: safeError(reason),
          requires_manual_review: true,
        })
      }
    }

    const observations = screenshotReads.flatMap(({ screenshotIndex, record, result }) =>
      result.teams.map((team, teamIndex) => ({
        team,
        teamIndex,
        source: {
          screenshotIndex,
          attachmentId: record.attachmentId,
          filename: record.attachmentFilename,
          originalSha256: result.source.original_sha256 ?? record.sha256 ?? null,
        },
      })))
    const conflicts = [...readErrors]
    const reviewFields = readErrors.map((error) => `screenshots[${error.screenshot_index}]`)
    collectIdentityConflicts(observations, conflicts, reviewFields)
    const teams = serializeMergedTeams(mergeTeams(observations), conflicts, reviewFields)
    const killTotalValidations = validatePlayerKillTotals(teams, conflicts, reviewFields)

    const uniqueReviewFields = [...new Set(reviewFields)]
    return {
      schema_version: 'nightraid.round-submission.v1',
      submission: {
        submission_id: submission.submissionId,
        round: submission.round,
        guild_id: submission.guildId,
        channel_id: submission.channelId,
        message_id: submission.messageId,
      },
      screenshot_count: submission.records.length,
      screenshots_read: screenshotReads.length,
      screenshots: submission.records.map((record, screenshotIndex) => {
        const read = screenshotReads.find((item) => item.screenshotIndex === screenshotIndex)
        return {
          screenshot_index: screenshotIndex,
          attachment_id: record.attachmentId,
          filename: record.attachmentFilename,
          status: read ? 'read' : 'failed',
          original_sha256:
            read?.result.source.original_sha256
            ?? record.sha256
            ?? null,
          observed_team_count: read?.result.teams.length ?? 0,
          reader: read?.result.readers?.primary ?? null,
          layout: read?.result.layout ?? null,
          targeted_recovery:
            read?.result.readers?.targeted_recovery
            ?? {
              supported: false,
              candidate_team_count: 0,
              attempted_team_count: 0,
              recovered_field_count: 0,
              skipped_team_count: 0,
            },
          targeted_recovery_attempts:
            read?.result.targeted_recovery?.attempts
            ?? [],
          unresolved_fields: read?.result.review_fields ?? [],
        }
      }),
      teams,
      ignored_rows: ignoredRows,
      kill_total_validations: killTotalValidations,
      conflicts,
      review_required: conflicts.length > 0 || uniqueReviewFields.length > 0,
      review_fields: uniqueReviewFields,
    }
  }

  async function close() {
    if (ownsSingleReader) await singleScreenshotReader.close?.()
  }

  return { readSubmission, close }
}
