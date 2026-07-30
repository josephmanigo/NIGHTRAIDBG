import { createClient } from '@supabase/supabase-js'

const MIGRATION_FILE =
  'database/phase9.sql through database/phase16.sql'
const SUBMISSIONS_TABLE = 'game_result_submissions'
const SCREENSHOTS_TABLE = 'game_result_screenshots'
const SHEET_WRITE_AUDITS_TABLE = 'game_result_sheet_write_audits'
const PLAYER_HISTORY_VIEW = 'game_result_player_history_for_calculations'
const MVP_REVIEWS_TABLE = 'game_result_mvp_reviews'
const HISTORY_SNAPSHOTS_TABLE = 'game_result_history_snapshots'
const ADMIN_OPERATIONS_TABLE = 'game_result_admin_operations'
const UNIQUE_VIOLATION = '23505'

function requiredEnvironment(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function safeDatabaseError(error, fallback) {
  const detail = error?.message || error?.details || fallback
  return String(detail).replace(/\s+/g, ' ').trim().slice(0, 500)
}

function submissionFromRow(row, screenshots = []) {
  const screenshotRecords = screenshots.map((screenshot) => ({
    submissionId: screenshot.submission_id,
    attachmentId: screenshot.attachment_id,
    attachmentFilename: screenshot.filename,
    attachmentUrl: screenshot.screenshot_url,
    sha256: screenshot.sha256,
    perceptualHash: screenshot.perceptual_hash,
    submissionTimestamp: screenshot.created_at,
    guildId: row.guild_id,
    channelId: row.channel_id,
    messageId: row.message_id,
    discordUserId: row.user_id,
    round: row.round_number,
    status:
      screenshot.status === 'duplicate' || screenshot.status === 'deleted'
        ? screenshot.status
        : row.status,
    duplicateOf: screenshot.duplicate_of,
  }))
  return {
    submissionId: row.id,
    round: row.round_number,
    guildId: row.guild_id,
    channelId: row.channel_id,
    messageId: row.message_id,
    discordUserId: row.user_id,
    status: row.status,
    createdTimestamp: row.created_at,
    updatedTimestamp: row.updated_at,
    reviewPayload: row.review_payload ?? null,
    reviewMessageId: row.review_message_id ?? null,
    reviewPage: row.review_page ?? 0,
    reviewVersion: row.review_version ?? 0,
    reviewUpdatedBy: row.review_updated_by ?? null,
    reviewUpdatedAt: row.review_updated_at ?? null,
    confirmedBy: row.confirmed_by ?? null,
    confirmedAt: row.confirmed_at ?? null,
    records: screenshotRecords.filter(
      (record) => record.status !== 'duplicate' && record.status !== 'deleted',
    ),
    duplicateRecords: screenshotRecords.filter((record) => record.status === 'duplicate'),
    deletedRecords: screenshotRecords.filter((record) => record.status === 'deleted'),
  }
}

function sheetWriteAuditFromRow(row) {
  if (!row) return null
  return {
    auditId: row.id,
    submissionId: row.submission_id,
    scoreSheetMode: row.score_sheet_mode ?? 'test',
    spreadsheetId: row.spreadsheet_id,
    worksheetName: row.worksheet_name,
    sheetId: Number(row.sheet_id),
    round: row.round_number,
    writeKind: row.write_kind ?? 'initial',
    supersedesAuditId: row.supersedes_audit_id ?? null,
    correctionAuthorizedBy: row.correction_authorized_by ?? null,
    status: row.status,
    sheetWriteApplied: row.sheet_write_applied,
    targetCells: row.target_cells,
    beforeSnapshot: row.before_snapshot,
    afterSnapshot: row.after_snapshot,
    writePayload: row.write_payload,
    verification: row.verification,
    error: row.error,
    createdBy: row.created_by,
    createdTimestamp: row.created_at,
    updatedTimestamp: row.updated_at,
    rolledBackBy: row.rolled_back_by,
    rolledBackAt: row.rolled_back_at,
  }
}

function mvpReviewFromRow(row) {
  if (!row) return null
  return {
    reviewId: row.id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    reviewMessageId: row.review_message_id ?? null,
    status: row.status,
    reviewVersion: row.review_version ?? 0,
    scoreSheetMode: row.score_sheet_mode,
    spreadsheetId: row.spreadsheet_id,
    productionWorksheetName: row.production_worksheet_name,
    productionSheetId: Number(row.production_sheet_id),
    mvpWorksheetName: row.mvp_worksheet_name,
    mvpSheetId: Number(row.mvp_sheet_id),
    sourceFingerprint: row.source_fingerprint,
    sourceSnapshots: row.source_snapshots ?? [],
    champion: row.champion,
    roster: row.roster ?? [],
    issues: row.issues ?? [],
    beforeSnapshot: row.before_snapshot,
    afterSnapshot: row.after_snapshot,
    writePayload: row.write_payload,
    verification: row.verification,
    sheetWriteApplied: row.sheet_write_applied ?? false,
    createdBy: row.created_by,
    confirmedBy: row.confirmed_by ?? null,
    closedBy: row.closed_by ?? null,
    error: row.error ?? null,
    createdTimestamp: row.created_at,
    updatedTimestamp: row.updated_at,
    confirmedTimestamp: row.confirmed_at ?? null,
    invalidatedTimestamp: row.invalidated_at ?? null,
    invalidatedBy: row.invalidated_by ?? null,
    invalidationReason: row.invalidation_reason ?? null,
  }
}

function historySnapshotFromRow(row) {
  if (!row) return null
  return {
    snapshotId: row.id,
    submissionId: row.submission_id,
    sheetWriteAuditId: row.sheet_write_audit_id,
    scoreSheetMode: row.score_sheet_mode,
    round: row.round_number,
    revision: row.revision_number,
    recordKind: row.record_kind,
    recordStatus: row.record_status,
    supersedesSnapshotId: row.supersedes_snapshot_id ?? null,
    submittedBy: row.submitted_by,
    approvedBy: row.approved_by,
    correctionBy: row.correction_by ?? null,
    screenshotUrls: row.screenshot_urls ?? [],
    discordMessageUrl: row.discord_message_url,
    recordedTimestamp: row.recorded_at,
  }
}

function adminOperationFromRow(row) {
  if (!row) return null
  return {
    operationId: row.id,
    operationKind: row.operation_kind,
    status: row.status,
    reviewVersion: row.review_version ?? 0,
    guildId: row.guild_id,
    channelId: row.channel_id,
    reviewMessageId: row.review_message_id ?? null,
    scoreSheetMode: row.score_sheet_mode,
    spreadsheetId: row.spreadsheet_id,
    worksheetName: row.worksheet_name,
    sheetId: Number(row.sheet_id),
    round: row.round_number,
    submissionId: row.submission_id,
    sourceSnapshotId: row.source_snapshot_id ?? null,
    relatedSheetAuditId: row.related_sheet_audit_id ?? null,
    relatedOperationId: row.related_operation_id ?? null,
    requestedChanges: row.requested_changes ?? {},
    preview: row.preview ?? {},
    beforeSnapshot: row.before_snapshot ?? {},
    afterSnapshot: row.after_snapshot ?? null,
    verification: row.verification ?? null,
    result: row.result ?? null,
    sheetWriteApplied: row.sheet_write_applied ?? false,
    historyStateChanged: row.history_state_changed ?? false,
    createdBy: row.created_by,
    confirmedBy: row.confirmed_by ?? null,
    cancelledBy: row.cancelled_by ?? null,
    error: row.error ?? null,
    createdTimestamp: row.created_at,
    updatedTimestamp: row.updated_at,
    completedTimestamp: row.completed_at ?? null,
  }
}

export function createSupabaseGameResultsStore(options = {}) {
  const client =
    options.client
    ?? createClient(
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

  async function initialize() {
    const { error } = await client
      .from(SUBMISSIONS_TABLE)
      .select('id', { head: true, count: 'exact' })
      .limit(1)
    if (error) {
      throw new Error(
        `Game-results storage is unavailable. Apply ${MIGRATION_FILE}: `
        + safeDatabaseError(error, 'database initialization failed'),
      )
    }
  }

  async function initializeMvp() {
    const { error } = await client
      .from(MVP_REVIEWS_TABLE)
      .select('id', { head: true, count: 'exact' })
      .limit(1)
    if (error) {
      throw new Error(
        `MVP workflow storage is unavailable. Apply database/phase14.sql: `
        + safeDatabaseError(error, 'MVP database initialization failed'),
      )
    }
  }

  async function initializeAdmin() {
    const { error } = await client
      .from(ADMIN_OPERATIONS_TABLE)
      .select('id', { head: true, count: 'exact' })
      .limit(1)
    if (error) {
      throw new Error(
        'Administrative correction storage is unavailable. Apply database/phase15.sql: '
        + safeDatabaseError(error, 'administrative database initialization failed'),
      )
    }
  }

  async function screenshotsForSubmission(submissionId) {
    const { data, error } = await client
      .from(SCREENSHOTS_TABLE)
      .select('*')
      .eq('submission_id', submissionId)
      .order('created_at', { ascending: true })
    if (error) throw new Error(safeDatabaseError(error, 'Could not load stored screenshots.'))
    return data ?? []
  }

  async function findSubmissionByMessage({ guildId, channelId, messageId }) {
    const { data: row, error } = await client
      .from(SUBMISSIONS_TABLE)
      .select('*')
      .eq('guild_id', guildId)
      .eq('channel_id', channelId)
      .eq('message_id', messageId)
      .maybeSingle()
    if (error) throw new Error(safeDatabaseError(error, 'Could not load the screenshot submission.'))
    if (!row) return null
    return submissionFromRow(row, await screenshotsForSubmission(row.id))
  }

  async function findSubmissionById(submissionId) {
    const { data: row, error } = await client
      .from(SUBMISSIONS_TABLE)
      .select('*')
      .eq('id', submissionId)
      .maybeSingle()
    if (error) throw new Error(safeDatabaseError(error, 'Could not load the screenshot submission.'))
    if (!row) return null
    return submissionFromRow(row, await screenshotsForSubmission(row.id))
  }

  async function findLatestSubmission({ guildId, channelId, statuses = [] }) {
    let query = client
      .from(SUBMISSIONS_TABLE)
      .select('*')
      .eq('guild_id', guildId)
      .eq('channel_id', channelId)
    if (statuses.length > 0) query = query.in('status', statuses)
    const { data: row, error } = await query
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) {
      throw new Error(safeDatabaseError(error, 'Could not load the latest screenshot submission.'))
    }
    if (!row) return null
    return submissionFromRow(row, await screenshotsForSubmission(row.id))
  }

  async function insertSubmission(metadata) {
    const values = {
      guild_id: metadata.guildId,
      channel_id: metadata.channelId,
      message_id: metadata.messageId,
      user_id: metadata.discordUserId,
      status: 'pending',
      created_at: metadata.submissionTimestamp,
    }
    const { data, error } = await client
      .from(SUBMISSIONS_TABLE)
      .insert(values)
      .select('*')
      .single()
    if (!error) return data
    if (error.code === UNIQUE_VIOLATION) {
      const existing = await findSubmissionByMessage(metadata)
      if (existing) {
        return {
          id: existing.submissionId,
          round_number: existing.round,
          guild_id: existing.guildId,
          channel_id: existing.channelId,
          message_id: existing.messageId,
          user_id: existing.discordUserId,
          status: existing.status,
          created_at: existing.createdTimestamp,
          updated_at: existing.updatedTimestamp,
        }
      }
    }
    throw new Error(safeDatabaseError(error, 'Could not create the screenshot submission.'))
  }

  async function existingScreenshotByHash(sha256) {
    const { data, error } = await client
      .from(SCREENSHOTS_TABLE)
      .select('*')
      .eq('sha256', sha256)
      .neq('status', 'duplicate')
      .neq('status', 'deleted')
      .maybeSingle()
    if (error) throw new Error(safeDatabaseError(error, 'Could not check screenshot duplication.'))
    return data
  }

  async function tombstoneDeletedMessage({ guildId, channelId, messageId }) {
    const { data, error } = await client.rpc('tombstone_deleted_game_result_message', {
      p_guild_id: guildId,
      p_channel_id: channelId,
      p_message_id: messageId,
    })
    if (error) {
      throw new Error(
        safeDatabaseError(
          error,
          'Could not remove screenshots for the deleted Discord message.',
        ),
      )
    }
    return data ?? {
      found: false,
      screenshots_removed: 0,
      submission_deleted: false,
    }
  }

  async function existingScreenshotByAttachment(attachmentId) {
    const { data, error } = await client
      .from(SCREENSHOTS_TABLE)
      .select('*')
      .eq('attachment_id', attachmentId)
      .maybeSingle()
    if (error) throw new Error(safeDatabaseError(error, 'Could not check the stored attachment.'))
    return data
  }

  async function setSubmissionStatus(submissionId, status) {
    const { error } = await client
      .from(SUBMISSIONS_TABLE)
      .update({ status })
      .eq('id', submissionId)
    if (error) throw new Error(safeDatabaseError(error, `Could not mark submission ${status}.`))
  }

  async function createPendingSubmission(metadata, records) {
    const row = await insertSubmission(metadata)
    const accepted = []
    const duplicates = []

    for (const record of records) {
      const storedAttachment = await existingScreenshotByAttachment(record.attachmentId)
      if (storedAttachment) {
        if (storedAttachment.status === 'duplicate') {
          duplicates.push({ record, existing: null, duplicate: storedAttachment })
        } else {
          accepted.push(storedAttachment)
        }
        continue
      }

      const values = {
        submission_id: row.id,
        attachment_id: record.attachmentId,
        screenshot_url: record.attachmentUrl,
        filename: record.attachmentFilename,
        sha256: record.sha256,
        perceptual_hash: record.perceptualHash,
        status: 'pending',
        duplicate_of: null,
        created_at: record.submissionTimestamp,
      }
      const { data, error } = await client
        .from(SCREENSHOTS_TABLE)
        .insert(values)
        .select('*')
        .single()
      if (!error) {
        accepted.push(data)
        continue
      }
      if (error.code === UNIQUE_VIOLATION) {
        const existing = await existingScreenshotByHash(record.sha256)
        if (existing?.submission_id === row.id && existing.attachment_id === record.attachmentId) {
          accepted.push(existing)
          continue
        }
        if (existing) {
          const duplicateValues = {
            ...values,
            status: 'duplicate',
            duplicate_of: existing.id,
          }
          const { data: duplicate, error: duplicateError } = await client
            .from(SCREENSHOTS_TABLE)
            .insert(duplicateValues)
            .select('*')
            .single()
          if (!duplicateError) {
            duplicates.push({ record, existing, duplicate })
            continue
          }
          const racedAttachment = await existingScreenshotByAttachment(record.attachmentId)
          if (duplicateError.code === UNIQUE_VIOLATION && racedAttachment?.status === 'duplicate') {
            duplicates.push({ record, existing, duplicate: racedAttachment })
            continue
          }
          await setSubmissionStatus(row.id, 'failed').catch(() => undefined)
          throw new Error(safeDatabaseError(duplicateError, 'Could not record a duplicate screenshot.'))
        }
      }
      await setSubmissionStatus(row.id, 'failed').catch(() => undefined)
      throw new Error(safeDatabaseError(error, 'Could not store a screenshot.'))
    }

    const status = accepted.length === 0 && duplicates.length > 0 ? 'duplicate' : 'pending'
    if (row.status !== status) await setSubmissionStatus(row.id, status)
    const current = await findSubmissionByMessage(metadata)
    return {
      submission: current,
      acceptedCount: accepted.length,
      duplicates,
    }
  }

  async function selectRound({ submissionId, discordUserId, round }) {
    const { data: row, error } = await client
      .from(SUBMISSIONS_TABLE)
      .update({ round_number: round })
      .eq('id', submissionId)
      .eq('user_id', discordUserId)
      .eq('status', 'pending')
      .is('round_number', null)
      .select('*')
      .maybeSingle()
    if (error) throw new Error(safeDatabaseError(error, 'Could not save the selected round.'))
    if (!row) throw new Error('The pending screenshot submission could not be updated.')
    return submissionFromRow(row, await screenshotsForSubmission(row.id))
  }

  async function saveReviewState({
    submissionId,
    payload,
    page,
    messageId,
    status,
    updatedBy,
    expectedVersion,
    confirmedBy,
    round,
  }) {
    const values = {
      review_payload: payload,
      review_page: page,
      review_version: expectedVersion + 1,
      review_updated_by: updatedBy ?? null,
      review_updated_at: new Date().toISOString(),
    }
    if (messageId !== undefined) values.review_message_id = messageId
    if (status !== undefined) values.status = status
    if (round !== undefined) values.round_number = round
    if (confirmedBy !== undefined) {
      values.confirmed_by = confirmedBy
      values.confirmed_at = confirmedBy ? new Date().toISOString() : null
    }

    const { data: row, error } = await client
      .from(SUBMISSIONS_TABLE)
      .update(values)
      .eq('id', submissionId)
      .eq('review_version', expectedVersion)
      .select('*')
      .maybeSingle()
    if (error) throw new Error(safeDatabaseError(error, 'Could not save the Discord review state.'))
    if (!row) {
      throw new Error('The Discord review changed before this action could be saved. Refresh and try again.')
    }
    return submissionFromRow(row, await screenshotsForSubmission(row.id))
  }

  async function updateSubmissionStatus({ submissionId, status, allowedStatuses }) {
    let query = client
      .from(SUBMISSIONS_TABLE)
      .update({ status })
      .eq('id', submissionId)
    if (Array.isArray(allowedStatuses) && allowedStatuses.length > 0) {
      query = query.in('status', allowedStatuses)
    }
    const { data: row, error } = await query.select('*').maybeSingle()
    if (error) throw new Error(safeDatabaseError(error, `Could not mark submission ${status}.`))
    if (!row) throw new Error(`The submission cannot be marked ${status} from its current status.`)
    return submissionFromRow(row, await screenshotsForSubmission(row.id))
  }

  async function createSheetWriteAudit({
    submissionId,
    scoreSheetMode,
    spreadsheetId,
    worksheetName,
    sheetId,
    round,
    writeKind,
    supersedesAuditId,
    correctionAuthorizedBy,
    targetCells,
    beforeSnapshot,
    writePayload,
    createdBy,
  }) {
    const { data: row, error } = await client
      .from(SHEET_WRITE_AUDITS_TABLE)
      .insert({
        submission_id: submissionId,
        score_sheet_mode: scoreSheetMode,
        spreadsheet_id: spreadsheetId,
        worksheet_name: worksheetName,
        sheet_id: sheetId,
        round_number: round,
        write_kind: writeKind,
        supersedes_audit_id: supersedesAuditId,
        correction_authorized_by: correctionAuthorizedBy,
        status: 'preparing',
        sheet_write_applied: false,
        target_cells: targetCells,
        before_snapshot: beforeSnapshot,
        write_payload: writePayload,
        created_by: createdBy,
      })
      .select('*')
      .single()
    if (error) {
      if (error.code === UNIQUE_VIOLATION) {
        throw new Error(
          'This confirmed round already has an active or verified score-sheet write.',
        )
      }
      throw new Error(safeDatabaseError(error, 'Could not create the spreadsheet update backup.'))
    }
    return sheetWriteAuditFromRow(row)
  }

  async function updateSheetWriteAudit({
    auditId,
    status,
    sheetWriteApplied,
    afterSnapshot,
    verification,
    error: auditError,
    rolledBackBy,
  }) {
    const values = { status }
    if (sheetWriteApplied !== undefined) values.sheet_write_applied = sheetWriteApplied
    if (afterSnapshot !== undefined) values.after_snapshot = afterSnapshot
    if (verification !== undefined) values.verification = verification
    if (auditError !== undefined) values.error = auditError
    if (rolledBackBy !== undefined) {
      values.rolled_back_by = rolledBackBy
      values.rolled_back_at = rolledBackBy ? new Date().toISOString() : null
    }
    const { data: row, error } = await client
      .from(SHEET_WRITE_AUDITS_TABLE)
      .update(values)
      .eq('id', auditId)
      .select('*')
      .maybeSingle()
    if (error) throw new Error(safeDatabaseError(error, 'Could not update the spreadsheet audit log.'))
    if (!row) throw new Error('The spreadsheet audit log no longer exists.')
    return sheetWriteAuditFromRow(row)
  }

  async function findSheetWriteAuditById(auditId) {
    const { data: row, error } = await client
      .from(SHEET_WRITE_AUDITS_TABLE)
      .select('*')
      .eq('id', auditId)
      .maybeSingle()
    if (error) throw new Error(safeDatabaseError(error, 'Could not load the spreadsheet audit log.'))
    return sheetWriteAuditFromRow(row)
  }

  async function findLatestSheetWriteAudit(submissionId, filters = {}) {
    let query = client
      .from(SHEET_WRITE_AUDITS_TABLE)
      .select('*')
      .eq('submission_id', submissionId)
    if (filters.scoreSheetMode) {
      query = query.eq('score_sheet_mode', filters.scoreSheetMode)
    }
    if (filters.round) query = query.eq('round_number', filters.round)
    if (filters.appliedOnly) query = query.eq('sheet_write_applied', true)
    const { data: row, error } = await query
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) throw new Error(safeDatabaseError(error, 'Could not load the spreadsheet audit log.'))
    return sheetWriteAuditFromRow(row)
  }

  async function findCurrentRoundSheetWrite({
    submissionId,
    scoreSheetMode,
    round,
  }) {
    const { data: rows, error } = await client
      .from(SHEET_WRITE_AUDITS_TABLE)
      .select('*')
      .eq('submission_id', submissionId)
      .eq('score_sheet_mode', scoreSheetMode)
      .eq('round_number', round)
      .in('status', ['preparing', 'written', 'verified', 'failed', 'rollback_failed'])
      .order('created_at', { ascending: false })
      .limit(20)
    if (error) throw new Error(safeDatabaseError(error, 'Could not check for an existing round write.'))
    const row = (rows ?? []).find((item) =>
      ['preparing', 'written', 'verified'].includes(item.status)
      || (['failed', 'rollback_failed'].includes(item.status) && item.sheet_write_applied))
    return sheetWriteAuditFromRow(row)
  }

  async function recordConfirmedPlayerHistory(history) {
    const { data, error } = await client.rpc('record_game_result_player_history', {
      p_submission_id: history.submissionId,
      p_sheet_write_audit_id: history.sheetWriteAuditId,
      p_score_sheet_mode: history.scoreSheetMode,
      p_round_number: history.round,
      p_record_kind: history.recordKind,
      p_submitted_by: history.submittedBy,
      p_approved_by: history.approvedBy,
      p_correction_by: history.correctionBy,
      p_screenshot_urls: history.screenshotUrls,
      p_discord_message_url: history.discordMessageUrl,
      p_players: history.players,
    })
    if (error) {
      throw new Error(safeDatabaseError(error, 'Could not record confirmed player history.'))
    }
    if (!data) throw new Error('Confirmed player history did not return a snapshot ID.')
    return {
      snapshotId: String(data),
      playerCount: history.players.length,
      recordKind: history.recordKind,
    }
  }

  async function rollbackConfirmedPlayerHistory({ sheetWriteAuditId, actorUserId }) {
    const { data, error } = await client.rpc('rollback_game_result_player_history', {
      p_sheet_write_audit_id: sheetWriteAuditId,
      p_actor: actorUserId,
    })
    if (error) {
      throw new Error(safeDatabaseError(error, 'Could not roll back confirmed player history.'))
    }
    return data ? { snapshotId: String(data), rolledBack: true } : null
  }

  async function loadConfirmedProductionPlayerHistories() {
    const { data, error } = await client
      .from(PLAYER_HISTORY_VIEW)
      .select('*')
      .order('round_number', { ascending: true })
      .order('player_slot', { ascending: true })
    if (error) {
      throw new Error(
        safeDatabaseError(error, 'Could not load confirmed production player history.'),
      )
    }
    return data ?? []
  }

  async function createMvpReview(input) {
    const { data: row, error } = await client
      .from(MVP_REVIEWS_TABLE)
      .insert({
        guild_id: input.guildId,
        channel_id: input.channelId,
        status: 'pending',
        review_version: 0,
        score_sheet_mode: input.scoreSheetMode,
        spreadsheet_id: input.spreadsheetId,
        production_worksheet_name: input.productionWorksheetName,
        production_sheet_id: input.productionSheetId,
        mvp_worksheet_name: input.mvpWorksheetName,
        mvp_sheet_id: input.mvpSheetId,
        source_fingerprint: input.sourceFingerprint,
        source_snapshots: input.sourceSnapshots,
        champion: input.champion,
        roster: input.roster,
        issues: input.issues,
        before_snapshot: input.beforeSnapshot,
        write_payload: input.writePayload,
        created_by: input.createdBy,
      })
      .select('*')
      .single()
    if (error) {
      throw new Error(safeDatabaseError(error, 'Could not save the MVP preview.'))
    }
    return mvpReviewFromRow(row)
  }

  async function saveMvpReviewMessage({ reviewId, messageId, expectedVersion }) {
    const { data: row, error } = await client
      .from(MVP_REVIEWS_TABLE)
      .update({
        review_message_id: messageId,
        review_version: expectedVersion + 1,
      })
      .eq('id', reviewId)
      .eq('status', 'pending')
      .eq('review_version', expectedVersion)
      .is('invalidated_at', null)
      .select('*')
      .maybeSingle()
    if (error) {
      throw new Error(safeDatabaseError(error, 'Could not attach the persistent MVP preview.'))
    }
    if (!row) throw new Error('The MVP preview changed before its Discord message was saved.')
    return mvpReviewFromRow(row)
  }

  async function findMvpReviewById(reviewId) {
    const { data: row, error } = await client
      .from(MVP_REVIEWS_TABLE)
      .select('*')
      .eq('id', reviewId)
      .maybeSingle()
    if (error) throw new Error(safeDatabaseError(error, 'Could not load the MVP preview.'))
    return mvpReviewFromRow(row)
  }

  async function claimMvpReview({ reviewId, actorUserId, expectedVersion }) {
    const { data: row, error } = await client
      .from(MVP_REVIEWS_TABLE)
      .update({
        status: 'processing',
        review_version: expectedVersion + 1,
        confirmed_by: actorUserId,
      })
      .eq('id', reviewId)
      .eq('status', 'pending')
      .eq('review_version', expectedVersion)
      .is('invalidated_at', null)
      .select('*')
      .maybeSingle()
    if (error) {
      if (error.code === UNIQUE_VIOLATION) {
        throw new Error(
          'This set of four confirmed rounds already has an active or completed MVP write.',
        )
      }
      throw new Error(safeDatabaseError(error, 'Could not claim the MVP update.'))
    }
    if (!row) throw new Error('This MVP preview is outdated or already closed.')
    return mvpReviewFromRow(row)
  }

  async function completeMvpReview({
    reviewId,
    expectedVersion,
    afterSnapshot,
    verification,
  }) {
    const { data: row, error } = await client
      .from(MVP_REVIEWS_TABLE)
      .update({
        status: 'confirmed',
        review_version: expectedVersion + 1,
        sheet_write_applied: true,
        after_snapshot: afterSnapshot,
        verification,
        error: null,
        confirmed_at: new Date().toISOString(),
      })
      .eq('id', reviewId)
      .eq('status', 'processing')
      .eq('review_version', expectedVersion)
      .select('*')
      .maybeSingle()
    if (error) {
      throw new Error(safeDatabaseError(error, 'Could not complete the MVP audit.'))
    }
    if (!row) throw new Error('The MVP audit changed before verification was saved.')
    return mvpReviewFromRow(row)
  }

  async function failMvpReview({
    reviewId,
    expectedVersion,
    sheetWriteApplied,
    error: reviewError,
  }) {
    const { data: row, error } = await client
      .from(MVP_REVIEWS_TABLE)
      .update({
        status: 'failed',
        review_version: expectedVersion + 1,
        sheet_write_applied: sheetWriteApplied,
        error: reviewError,
      })
      .eq('id', reviewId)
      .eq('status', 'processing')
      .eq('review_version', expectedVersion)
      .select('*')
      .maybeSingle()
    if (error) throw new Error(safeDatabaseError(error, 'Could not save the MVP failure audit.'))
    if (!row) throw new Error('The MVP failure audit could not be saved.')
    return mvpReviewFromRow(row)
  }

  async function closeMvpReview({
    reviewId,
    status,
    actorUserId,
    expectedVersion,
  }) {
    if (!['rejected', 'cancelled'].includes(status)) {
      throw new Error('MVP previews may only be rejected or cancelled.')
    }
    const { data: row, error } = await client
      .from(MVP_REVIEWS_TABLE)
      .update({
        status,
        review_version: expectedVersion + 1,
        closed_by: actorUserId,
      })
      .eq('id', reviewId)
      .eq('status', 'pending')
      .eq('review_version', expectedVersion)
      .select('*')
      .maybeSingle()
    if (error) throw new Error(safeDatabaseError(error, `Could not mark MVP preview ${status}.`))
    if (!row) throw new Error('This MVP preview is outdated or already closed.')
    return mvpReviewFromRow(row)
  }

  async function findRoundHistory({ round, recordStatus = 'active', scoreSheetMode = 'production' }) {
    const { data: row, error } = await client
      .from(HISTORY_SNAPSHOTS_TABLE)
      .select('*')
      .eq('score_sheet_mode', scoreSheetMode)
      .eq('round_number', round)
      .eq('record_status', recordStatus)
      .order('revision_number', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) throw new Error(safeDatabaseError(error, 'Could not load round history.'))
    if (!row) return null
    return {
      snapshot: historySnapshotFromRow(row),
      submission: await findSubmissionById(row.submission_id),
    }
  }

  async function createAdminOperation(input) {
    const { data: row, error } = await client
      .from(ADMIN_OPERATIONS_TABLE)
      .insert({
        operation_kind: input.operationKind,
        status: 'pending',
        review_version: 0,
        guild_id: input.guildId,
        channel_id: input.channelId,
        score_sheet_mode: input.scoreSheetMode,
        spreadsheet_id: input.spreadsheetId,
        worksheet_name: input.worksheetName,
        sheet_id: input.sheetId,
        round_number: input.round,
        submission_id: input.submissionId,
        source_snapshot_id: input.sourceSnapshotId,
        related_sheet_audit_id: input.relatedSheetAuditId,
        related_operation_id: input.relatedOperationId,
        requested_changes: input.requestedChanges ?? {},
        preview: input.preview ?? {},
        before_snapshot: input.beforeSnapshot ?? {},
        created_by: input.createdBy,
      })
      .select('*')
      .single()
    if (error) throw new Error(safeDatabaseError(error, 'Could not save the administrative preview.'))
    return adminOperationFromRow(row)
  }

  async function saveAdminOperationMessage({ operationId, messageId, expectedVersion }) {
    const { data: row, error } = await client
      .from(ADMIN_OPERATIONS_TABLE)
      .update({
        review_message_id: messageId,
        review_version: expectedVersion + 1,
      })
      .eq('id', operationId)
      .eq('status', 'pending')
      .eq('review_version', expectedVersion)
      .select('*')
      .maybeSingle()
    if (error) throw new Error(safeDatabaseError(error, 'Could not attach the administrative preview.'))
    if (!row) throw new Error('The administrative preview changed before its message was saved.')
    return adminOperationFromRow(row)
  }

  async function findAdminOperationById(operationId) {
    const { data: row, error } = await client
      .from(ADMIN_OPERATIONS_TABLE)
      .select('*')
      .eq('id', operationId)
      .maybeSingle()
    if (error) throw new Error(safeDatabaseError(error, 'Could not load the administrative operation.'))
    return adminOperationFromRow(row)
  }

  async function findLatestCompletedAdminOperation({ round, operationKind }) {
    let query = client
      .from(ADMIN_OPERATIONS_TABLE)
      .select('*')
      .eq('score_sheet_mode', 'production')
      .eq('round_number', round)
      .eq('status', 'completed')
    if (operationKind) query = query.eq('operation_kind', operationKind)
    const { data: row, error } = await query
      .order('completed_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) throw new Error(safeDatabaseError(error, 'Could not load prior administrative history.'))
    return adminOperationFromRow(row)
  }

  async function claimAdminOperation({ operationId, actorUserId, expectedVersion }) {
    const { data: row, error } = await client
      .from(ADMIN_OPERATIONS_TABLE)
      .update({
        status: 'processing',
        review_version: expectedVersion + 1,
        confirmed_by: actorUserId,
      })
      .eq('id', operationId)
      .eq('status', 'pending')
      .eq('review_version', expectedVersion)
      .select('*')
      .maybeSingle()
    if (error) {
      if (error.code === UNIQUE_VIOLATION) {
        throw new Error('Another administrative operation is processing for this round.')
      }
      throw new Error(safeDatabaseError(error, 'Could not claim the administrative operation.'))
    }
    if (!row) throw new Error('This administrative preview is outdated or already closed.')
    return adminOperationFromRow(row)
  }

  async function completeAdminOperation(input) {
    const { data: row, error } = await client
      .from(ADMIN_OPERATIONS_TABLE)
      .update({
        status: 'completed',
        review_version: input.expectedVersion + 1,
        related_sheet_audit_id: input.relatedSheetAuditId,
        related_operation_id: input.relatedOperationId,
        after_snapshot: input.afterSnapshot,
        verification: input.verification,
        result: input.result,
        sheet_write_applied: input.sheetWriteApplied ?? false,
        history_state_changed: input.historyStateChanged ?? false,
        error: null,
        completed_at: new Date().toISOString(),
      })
      .eq('id', input.operationId)
      .eq('status', 'processing')
      .eq('review_version', input.expectedVersion)
      .select('*')
      .maybeSingle()
    if (error) throw new Error(safeDatabaseError(error, 'Could not complete the administrative audit.'))
    if (!row) throw new Error('The administrative audit changed before completion.')
    return adminOperationFromRow(row)
  }

  async function failAdminOperation(input) {
    const { data: row, error } = await client
      .from(ADMIN_OPERATIONS_TABLE)
      .update({
        status: 'failed',
        review_version: input.expectedVersion + 1,
        after_snapshot: input.afterSnapshot,
        verification: input.verification,
        result: input.result,
        sheet_write_applied: input.sheetWriteApplied ?? false,
        history_state_changed: input.historyStateChanged ?? false,
        error: input.error,
        completed_at: new Date().toISOString(),
      })
      .eq('id', input.operationId)
      .eq('status', 'processing')
      .eq('review_version', input.expectedVersion)
      .select('*')
      .maybeSingle()
    if (error) throw new Error(safeDatabaseError(error, 'Could not save the administrative failure audit.'))
    if (!row) throw new Error('The administrative failure audit could not be saved.')
    return adminOperationFromRow(row)
  }

  async function cancelAdminOperation({ operationId, actorUserId, expectedVersion }) {
    const { data: row, error } = await client
      .from(ADMIN_OPERATIONS_TABLE)
      .update({
        status: 'cancelled',
        review_version: expectedVersion + 1,
        cancelled_by: actorUserId,
        completed_at: new Date().toISOString(),
      })
      .eq('id', operationId)
      .eq('status', 'pending')
      .eq('review_version', expectedVersion)
      .select('*')
      .maybeSingle()
    if (error) throw new Error(safeDatabaseError(error, 'Could not cancel the administrative operation.'))
    if (!row) throw new Error('This administrative preview is outdated or already closed.')
    return adminOperationFromRow(row)
  }

  async function deleteRoundHistory({ submissionId, snapshotId, actorUserId }) {
    const { data, error } = await client.rpc('delete_game_result_round_history', {
      p_submission_id: submissionId,
      p_snapshot_id: snapshotId,
      p_actor: actorUserId,
    })
    if (error) throw new Error(safeDatabaseError(error, 'Could not delete round history.'))
    return String(data)
  }

  async function restoreRoundHistory({ submissionId, snapshotId, actorUserId }) {
    const { data, error } = await client.rpc('restore_game_result_round_history', {
      p_submission_id: submissionId,
      p_snapshot_id: snapshotId,
      p_actor: actorUserId,
    })
    if (error) throw new Error(safeDatabaseError(error, 'Could not restore round history.'))
    return String(data)
  }

  async function invalidateMvpReviews({ actorUserId, reason }) {
    const { data, error } = await client
      .from(MVP_REVIEWS_TABLE)
      .update({
        invalidated_at: new Date().toISOString(),
        invalidated_by: actorUserId,
        invalidation_reason: reason,
      })
      .in('status', ['pending', 'confirmed'])
      .is('invalidated_at', null)
      .select('id')
    if (error) throw new Error(safeDatabaseError(error, 'Could not invalidate prior MVP previews.'))
    return (data ?? []).length
  }

  async function listRecoverableSubmissions() {
    const { data: rows, error } = await client
      .from(SUBMISSIONS_TABLE)
      .select('*')
      .in('status', ['pending', 'processing', 'failed'])
      .order('created_at', { ascending: true })
    if (error) {
      throw new Error(safeDatabaseError(error, 'Could not load recoverable submissions.'))
    }
    return Promise.all((rows ?? []).map(async (row) =>
      submissionFromRow(row, await screenshotsForSubmission(row.id))))
  }

  async function healthCheck() {
    const startedAt = Date.now()
    await initialize()
    const { count, error } = await client
      .from(SUBMISSIONS_TABLE)
      .select('id', { head: true, count: 'exact' })
      .in('status', ['pending', 'processing'])
    if (error) throw new Error(safeDatabaseError(error, 'Database health check failed.'))
    return {
      provider: 'supabase',
      ok: true,
      pendingSubmissions: count ?? 0,
      latencyMs: Date.now() - startedAt,
    }
  }

  async function exportBackupSnapshot() {
    const tables = [
      SUBMISSIONS_TABLE,
      SCREENSHOTS_TABLE,
      SHEET_WRITE_AUDITS_TABLE,
      'game_result_history_snapshots',
      'game_result_player_history',
      MVP_REVIEWS_TABLE,
      ADMIN_OPERATIONS_TABLE,
    ]
    const exported = {}
    for (const table of tables) {
      const { data, error } = await client
        .from(table)
        .select('*')
      if (error) {
        throw new Error(safeDatabaseError(error, `Could not back up ${table}.`))
      }
      exported[table] = data ?? []
    }
    return {
      schema: 'nightraid.game-results-backup.v1',
      provider: 'supabase',
      createdAt: new Date().toISOString(),
      tables: exported,
    }
  }

  return {
    initialize,
    initializeMvp,
    initializeAdmin,
    findSubmissionByMessage,
    findSubmissionById,
    findLatestSubmission,
    tombstoneDeletedMessage,
    createPendingSubmission,
    selectRound,
    saveReviewState,
    updateSubmissionStatus,
    createSheetWriteAudit,
    updateSheetWriteAudit,
    findSheetWriteAuditById,
    findLatestSheetWriteAudit,
    findCurrentRoundSheetWrite,
    recordConfirmedPlayerHistory,
    rollbackConfirmedPlayerHistory,
    loadConfirmedProductionPlayerHistories,
    createMvpReview,
    saveMvpReviewMessage,
    findMvpReviewById,
    claimMvpReview,
    completeMvpReview,
    failMvpReview,
    closeMvpReview,
    findRoundHistory,
    createAdminOperation,
    saveAdminOperationMessage,
    findAdminOperationById,
    findLatestCompletedAdminOperation,
    claimAdminOperation,
    completeAdminOperation,
    failAdminOperation,
    cancelAdminOperation,
    deleteRoundHistory,
    restoreRoundHistory,
    invalidateMvpReviews,
    listRecoverableSubmissions,
    healthCheck,
    exportBackupSnapshot,
  }
}
