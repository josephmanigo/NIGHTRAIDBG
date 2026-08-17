import { isDeepStrictEqual } from 'node:util'
import {
  applyPlayerReviewEdit,
  applyTeamReviewEdit,
  buildGameResultsReviewPayload,
} from './game-results-review.js'
import { createGameResultsAdministrativeSheetService } from './game-results-admin-sheet.js'
import { createChampionMvpService } from './game-results-mvp-sheet-writer.js'
import { createSafeGameResultsSheetWriter } from './game-results-sheet-writer.js'
import { createSupabaseGameResultsStore } from './game-results-store.js'
import { createTeamMappingService } from './game-results-team-mapper.js'

const OPERATION_KINDS = new Set([
  'edit_round',
  'delete_round',
  'restore_round',
  'reprocess_round',
  'rollback_update',
  'sync_score_sheet',
])

function compactError(reason) {
  return (reason instanceof Error ? reason.message : String(reason))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500)
}

function sheetValueFromTarget(target) {
  const number = target?.user_entered_value?.numberValue
  if (Number.isInteger(number)) return number
  const text = target?.user_entered_value?.stringValue
  if (target?.role === 'team_name') return text ?? null
  return text === 'X' ? 'X' : null
}

function sheetValues(inspection) {
  return Object.fromEntries(
    (inspection.targets ?? []).map((target) => [target.a1, sheetValueFromTarget(target)]),
  )
}

const ROUND_INPUT_COLUMNS = Object.freeze({
  1: { place: 'K', kills: 'M' },
  2: { place: 'N', kills: 'P' },
  3: { place: 'Q', kills: 'S' },
  4: { place: 'T', kills: 'V' },
})

function intendedSheetValues(payload, round) {
  const columns = ROUND_INPUT_COLUMNS[round]
  const values = {}
  ;(payload?.round_result?.teams ?? []).forEach((team, index) => {
    const row =
      payload?.mapping_result?.teams?.[index]?.mapping?.official_team?.worksheet_row
    if (!Number.isInteger(row)) return
    values[`${columns.place}${row}`] = team.rank
    values[`${columns.kills}${row}`] = team.team_total_kills
  })
  return values
}

function teamSummary(payload) {
  return (payload?.round_result?.teams ?? []).map((team, index) => ({
    team_index: index,
    rank: team.rank ?? null,
    team_code: team.team_code ?? null,
    official_team:
      payload?.mapping_result?.teams?.[index]?.mapping?.official_team ?? null,
    team_total_kills: team.team_total_kills ?? null,
    players: (team.players ?? []).map((player) => ({
      slot: player.slot ?? null,
      name: player.name ?? null,
      kills: player.kills ?? null,
    })),
  }))
}

function findTeamIndex(roundResult, teamCode) {
  const wanted = String(teamCode ?? '').trim().toUpperCase()
  const matches = (roundResult?.teams ?? [])
    .map((team, index) => ({ team, index }))
    .filter(({ team }) => String(team.team_code ?? '').trim().toUpperCase() === wanted)
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `Team code ${wanted || '(blank)'} is not present in this round.`
        : `Team code ${wanted} is ambiguous in this round.`,
    )
  }
  return matches[0].index
}

function editRoundResult(payload, changes) {
  const current = structuredClone(payload.round_result)
  const teamIndex = findTeamIndex(current, changes.teamCode)
  const team = current.teams[teamIndex]
  let next = applyTeamReviewEdit(current, teamIndex, {
    round: current.submission?.round,
    rank: changes.rank ?? team.rank,
    teamCode: team.team_code,
    officialTeam:
      team.official_team_selection
      ?? payload.mapping_result?.teams?.[teamIndex]?.mapping?.official_team?.slot_code
      ?? '',
    teamTotalKills: changes.teamTotalKills ?? team.team_total_kills,
  })
  if (
    changes.playerNumber !== undefined
    || changes.playerSlot !== undefined
    || changes.playerName !== undefined
    || changes.playerKills !== undefined
  ) {
    if (!Number.isInteger(changes.playerNumber)) {
      throw new Error('A player number is required when editing player fields.')
    }
    next = applyPlayerReviewEdit(next, teamIndex, {
      playerNumber: changes.playerNumber,
      slot: changes.playerSlot ?? '',
      name: changes.playerName ?? '',
      kills:
        changes.playerKills === undefined ? '' : String(changes.playerKills),
    })
  }
  return next
}

function outputFromMvpPreview(result) {
  if (!result?.preview) return null
  return {
    champion: result.preview.champion ?? null,
    players: result.preview.players ?? [],
    issues: result.preview.issues ?? [],
    blocking_issue_count: result.preview.blockingIssueCount ?? 0,
  }
}

export function createGameResultsAdminService(options = {}) {
  const store = options.store ?? createSupabaseGameResultsStore()
  const sheetService =
    options.sheetService
    ?? createGameResultsAdministrativeSheetService(options)
  const sheetWriter =
    options.sheetWriter
    ?? createSafeGameResultsSheetWriter({ ...options, store })
  const teamMappingService =
    options.teamMappingService
    ?? createTeamMappingService({
      scoreSheet: {
        worksheetName: 'New',
        allowNonTestWorksheet: true,
      },
    })
  const mvpService =
    options.mvpService
    ?? createChampionMvpService({ ...options, store, scoreSheetMode: 'production' })
  const reprocessSubmission = options.reprocessSubmission
  const backupService = options.backupService
  let initializationPromise

  function initialize() {
    initializationPromise ??= Promise.all([
      store.initialize(),
      store.initializeAdmin(),
    ])
    return initializationPromise
  }

  function requireProduction() {
    if (
      sheetService.config.mode !== 'production'
      || sheetWriter.config.mode !== 'production'
      || sheetService.config.worksheetName !== 'New'
    ) {
      throw new Error(
        'Administrative score changes require explicit SCORE_SHEET_MODE=production.',
      )
    }
  }

  async function prepareOperation({
    operationKind,
    round,
    changes = {},
    guildId,
    channelId,
    createdBy,
  }) {
    await initialize()
    requireProduction()
    if (!OPERATION_KINDS.has(operationKind)) {
      throw new Error('Unknown administrative operation.')
    }
    if (!Number.isInteger(round) || round < 1 || round > 4) {
      throw new Error('Round must be 1, 2, 3, or 4.')
    }
    const clearAllRounds =
      operationKind === 'delete_round'
      && changes.clearAllRounds === true
    if (clearAllRounds) {
      const histories = (await Promise.all(
        [1, 2, 3, 4].map(async (historyRound) => ({
          round: historyRound,
          history: await store.findRoundHistory({
            round: historyRound,
            recordStatus: 'active',
            scoreSheetMode: 'production',
          }),
        })),
      )).filter((item) => item.history?.submission?.reviewPayload)
      const inspection = await sheetService.inspectAllRounds()
      const currentSheetValues = sheetValues(inspection)
      const teamNameNonblankCount = inspection.teamTargets.filter(
        (target) => target.user_entered_value?.stringValue,
      ).length
      const proposedSheetValues = Object.fromEntries(
        Object.keys(currentSheetValues).map((cell) => [cell, null]),
      )
      const sheetDifferences = Object.entries(currentSheetValues)
        .filter(([, value]) => value !== null)
        .map(([cell, value]) => ({ cell, existing: value, proposed: null }))
      if (sheetDifferences.length === 0) {
        throw new Error('All four production round input areas are already blank.')
      }
      const primaryHistory = histories[0]?.history ?? null
      const primarySubmission =
        primaryHistory?.submission
        ?? await store.findLatestConfirmedSubmission?.()
      if (!primarySubmission) {
        throw new Error(
          'No confirmed submission is available for the persistent /clear audit.',
        )
      }
      const sourceRounds = histories.map(({ round: historyRound, history: item }) => ({
        round: historyRound,
        submission_id: item.submission.submissionId,
        snapshot_id: item.snapshot.snapshotId,
      }))
      return store.createAdminOperation({
        operationKind,
        guildId,
        channelId,
        scoreSheetMode: 'production',
        spreadsheetId: sheetService.config.spreadsheetId,
        worksheetName: sheetService.config.worksheetName,
        sheetId: sheetService.config.sheetId,
        round: 1,
        submissionId: primarySubmission.submissionId,
        sourceSnapshotId: primaryHistory?.snapshot.snapshotId ?? null,
        relatedSheetAuditId: null,
        relatedOperationId: null,
        requestedChanges: {
          clear_all_rounds: true,
          source_rounds: sourceRounds,
        },
        preview: {
          operation_kind: 'clear_sheet',
          clear_all_rounds: true,
          rounds: [1, 2, 3, 4],
          existing_sheet_values: currentSheetValues,
          proposed_sheet_values: proposedSheetValues,
          sheet_differences: sheetDifferences,
          active_history_rounds: sourceRounds.map((item) => item.round),
          formula_cells_checked: inspection.formulas.length,
          formulas_will_be_written: false,
          deductions_will_be_written: false,
          team_names_will_be_cleared: true,
          team_name_cells_checked: inspection.teamTargets.length,
          team_name_nonblank_count: teamNameNonblankCount,
        },
        beforeSnapshot: inspection.beforeSnapshot,
        createdBy,
      })
    }
    const restore = operationKind === 'restore_round'
    const history = await store.findRoundHistory({
      round,
      recordStatus: restore ? 'deleted' : 'active',
      scoreSheetMode: 'production',
    })
    if (!history?.submission?.reviewPayload) {
      throw new Error(
        restore
          ? `No deleted production Round ${round} is available to restore.`
          : `No active confirmed production Round ${round} is available.`,
      )
    }
    const inspection = await sheetService.inspectRound(round)
    let proposedPayload = history.submission.reviewPayload
    let relatedOperation = null
    if (operationKind === 'edit_round') {
      const roundResult = editRoundResult(proposedPayload, changes)
      const validated = await buildGameResultsReviewPayload({
        roundResult,
        teamMappingService,
      })
      proposedPayload = {
        ...proposedPayload,
        ...validated,
        score_sheet_mode: 'production',
        score_sheet_worksheet: 'New',
        correction_mode: true,
        correction_authorized_by: createdBy,
      }
      if (validated.blocking_issue_count > 0) {
        throw new Error(
          `The proposed edit has ${validated.blocking_issue_count} blocking validation issue(s).`,
        )
      }
    }
    if (operationKind === 'sync_score_sheet') {
      proposedPayload = {
        ...proposedPayload,
        score_sheet_mode: 'production',
        score_sheet_worksheet: 'New',
        correction_mode: true,
        correction_authorized_by: createdBy,
      }
    }
    const currentSheetValues = sheetValues(inspection)
    const proposedSheetValues = intendedSheetValues(proposedPayload, round)
    const sheetDifferences = Object.entries(proposedSheetValues)
      .filter(([cell, value]) => currentSheetValues[cell] !== value)
      .map(([cell, value]) => ({
        cell,
        existing: currentSheetValues[cell] ?? null,
        proposed: value,
      }))
    if (operationKind === 'sync_score_sheet' && sheetDifferences.length === 0) {
      throw new Error(`Production Round ${round} is already synchronized.`)
    }
    if (restore) {
      const allRoundClear = await store.findLatestCompletedClearOperation?.()
      const clearedByAllRoundReset = allRoundClear?.requestedChanges?.source_rounds?.some(
        (source) => source.snapshot_id === history.snapshot.snapshotId,
      )
      if (clearedByAllRoundReset) {
        throw new Error(
          `Production Round ${round} was reset by /clear and cannot be restored individually; tally it again instead.`,
        )
      }
      relatedOperation = await store.findLatestCompletedAdminOperation({
        round,
        operationKind: 'delete_round',
      })
      if (
        !relatedOperation
        || relatedOperation.submissionId !== history.submission.submissionId
      ) {
        throw new Error('The deleted round has no matching completed deletion backup.')
      }
    }
    const latestAudit = await store.findLatestSheetWriteAudit(
      history.submission.submissionId,
      { scoreSheetMode: 'production', round, appliedOnly: true },
    )
    const preview = {
      operation_kind: operationKind,
      round,
      submission_id: history.submission.submissionId,
      snapshot_id: history.snapshot.snapshotId,
      existing_sheet_values: currentSheetValues,
      proposed_sheet_values: proposedSheetValues,
      sheet_differences: sheetDifferences,
      existing_results: teamSummary(history.submission.reviewPayload),
      proposed_results: teamSummary(proposedPayload),
      changes,
      blocking_issue_count: proposedPayload.blocking_issue_count ?? 0,
      formula_cells_checked: inspection.formulas.length,
      formulas_will_be_written: false,
    }
    return store.createAdminOperation({
      operationKind,
      guildId,
      channelId,
      scoreSheetMode: 'production',
      spreadsheetId: sheetService.config.spreadsheetId,
      worksheetName: sheetService.config.worksheetName,
      sheetId: sheetService.config.sheetId,
      round,
      submissionId: history.submission.submissionId,
      sourceSnapshotId: history.snapshot.snapshotId,
      relatedSheetAuditId: latestAudit?.auditId ?? null,
      relatedOperationId: relatedOperation?.operationId ?? null,
      requestedChanges: {
        ...changes,
        proposed_review_payload: proposedPayload,
      },
      preview,
      beforeSnapshot: inspection.beforeSnapshot,
      createdBy,
    })
  }

  async function attachMessage(operation, messageId) {
    return store.saveAdminOperationMessage({
      operationId: operation.operationId,
      messageId,
      expectedVersion: operation.reviewVersion,
    })
  }

  async function findOperation(operationId) {
    await initialize()
    return store.findAdminOperationById(operationId)
  }

  async function postMutation(actorUserId, operationKind, round, { skipMvpPreview = false } = {}) {
    const reason = `${operationKind} changed production Round ${round}`
    const invalidatedMvpReviews = await store.invalidateMvpReviews({
      actorUserId,
      reason,
    }).catch(() => null)
    const mvpPreview = skipMvpPreview
      ? { skipped: true, reason: 'clear_all_rounds' }
      : await mvpService.previewCurrent()
        .then(outputFromMvpPreview)
        .catch((error) => ({ unavailable: compactError(error) }))
    return { invalidated_mvp_reviews: invalidatedMvpReviews, mvp_preview: mvpPreview }
  }

  async function executeOperation(operation, actorUserId, context = {}) {
    requireProduction()
    const claimed = await store.claimAdminOperation({
      operationId: operation.operationId,
      actorUserId,
      expectedVersion: operation.reviewVersion,
    })
    let sheetWriteApplied = false
    let historyStateChanged = false
    let afterSnapshot = null
    let verification = null
    try {
      const clearAllRounds =
        claimed.operationKind === 'delete_round'
        && claimed.requestedChanges?.clear_all_rounds === true
      let history = null
      if (!clearAllRounds) {
        history = await store.findRoundHistory({
          round: claimed.round,
          recordStatus: claimed.operationKind === 'restore_round' ? 'deleted' : 'active',
          scoreSheetMode: 'production',
        })
        if (
          !history
          || history.submission.submissionId !== claimed.submissionId
          || history.snapshot.snapshotId !== claimed.sourceSnapshotId
        ) {
          throw new Error('The round history changed after this preview.')
        }
      }
      let operationResult
      let relatedSheetAuditId = claimed.relatedSheetAuditId
      if (clearAllRounds) {
        const sources = claimed.requestedChanges?.source_rounds ?? []
        if (!Array.isArray(sources)) {
          throw new Error('The all-round clear audit has invalid source history snapshots.')
        }
        for (const source of sources) {
          const current = await store.findRoundHistory({
            round: source.round,
            recordStatus: 'active',
            scoreSheetMode: 'production',
          })
          if (
            !current
            || current.submission.submissionId !== source.submission_id
            || current.snapshot.snapshotId !== source.snapshot_id
          ) {
            throw new Error(`Production Round ${source.round} history changed after preview.`)
          }
        }
        await backupService?.backupNow('before_production_all_rounds_clear')
        const inspection = await sheetService.inspectAllRounds()
        if (!isDeepStrictEqual(inspection.beforeSnapshot, claimed.beforeSnapshot)) {
          throw new Error('The score sheet changed after the all-round clear preview.')
        }
        // Release large preview data — no longer needed after verification.
        // Keep beforeSnapshot alive for the error-recovery restore path below.
        const restoreSnapshot = claimed.beforeSnapshot
        claimed.preview = null
        const cleared = await sheetService.clearAllRounds({ inspection })
        sheetWriteApplied = true
        afterSnapshot = cleared.verification.afterSnapshot
        verification = cleared.verification
        const deletedSources = []
        try {
          for (const source of sources) {
            await store.deleteRoundHistory({
              submissionId: source.submission_id,
              snapshotId: source.snapshot_id,
              actorUserId,
            })
            deletedSources.push(source)
          }
          historyStateChanged = deletedSources.length > 0
        } catch (reason) {
          const current = await sheetService.inspectAllRounds()
          await sheetService.restoreAllRounds({
            inspection: current,
            restoreSnapshot,
          })
          for (const source of deletedSources.reverse()) {
            await store.restoreRoundHistory({
              submissionId: source.submission_id,
              snapshotId: source.snapshot_id,
              actorUserId,
            })
          }
          sheetWriteApplied = false
          historyStateChanged = false
          throw reason
        }
        operationResult = {
          score_sheet_cleared: true,
          cleared_rounds: [1, 2, 3, 4],
          deleted_history_rounds: sources.map((source) => source.round),
          deductions_preserved: true,
          team_names_cleared: true,
          formulas_preserved: true,
          rank_highlight_removed: true,
        }
      } else if (['edit_round', 'sync_score_sheet'].includes(claimed.operationKind)) {
        const submission = {
          ...history.submission,
          reviewPayload: claimed.requestedChanges.proposed_review_payload,
        }
        const result = await sheetWriter.writeConfirmedSubmission(
          submission,
          actorUserId,
          { correctionAuthorized: true },
        )
        sheetWriteApplied = true
        historyStateChanged = true
        afterSnapshot = result.verification.afterSnapshot
        verification = result.verification
        relatedSheetAuditId = result.audit.auditId
        operationResult = { writer_status: result.status }
      } else if (claimed.operationKind === 'delete_round') {
        await backupService?.backupNow(
          `before_production_round_${claimed.round}_delete`,
        )
        const inspection = await sheetService.inspectRound(claimed.round)
        if (!isDeepStrictEqual(inspection.beforeSnapshot, claimed.beforeSnapshot)) {
          throw new Error('The round values changed after this deletion preview.')
        }
        const cleared = await sheetService.clearRound({ inspection })
        sheetWriteApplied = true
        afterSnapshot = cleared.verification.afterSnapshot
        verification = cleared.verification
        try {
          await store.deleteRoundHistory({
            submissionId: claimed.submissionId,
            snapshotId: claimed.sourceSnapshotId,
            actorUserId,
          })
          historyStateChanged = true
        } catch (reason) {
          const current = await sheetService.inspectRound(claimed.round)
          await sheetService.restoreRound({
            inspection: current,
            restoreSnapshot: claimed.beforeSnapshot,
          })
          sheetWriteApplied = false
          throw reason
        }
        operationResult = { round_deleted: true }
      } else if (claimed.operationKind === 'restore_round') {
        await backupService?.backupNow(
          `before_production_round_${claimed.round}_restore`,
        )
        const deletion = await store.findAdminOperationById(claimed.relatedOperationId)
        if (!deletion?.beforeSnapshot) throw new Error('The deletion backup is unavailable.')
        const inspection = await sheetService.inspectRound(claimed.round)
        const restored = await sheetService.restoreRound({
          inspection,
          restoreSnapshot: deletion.beforeSnapshot,
        })
        sheetWriteApplied = true
        afterSnapshot = restored.verification.afterSnapshot
        verification = restored.verification
        try {
          await store.restoreRoundHistory({
            submissionId: claimed.submissionId,
            snapshotId: claimed.sourceSnapshotId,
            actorUserId,
          })
          historyStateChanged = true
        } catch (reason) {
          const current = await sheetService.inspectRound(claimed.round)
          await sheetService.clearRound({ inspection: current })
          sheetWriteApplied = false
          throw reason
        }
        operationResult = { round_restored: true }
      } else if (claimed.operationKind === 'rollback_update') {
        const result = await sheetWriter.rollbackConfirmedSubmission(
          history.submission,
          actorUserId,
        )
        historyStateChanged = true
        afterSnapshot = result.audit.afterSnapshot
        verification = result.audit.verification
        relatedSheetAuditId = result.audit.auditId
        operationResult = { writer_status: result.status }
      } else {
        if (!reprocessSubmission) {
          throw new Error('The screenshot review workflow is unavailable for reprocessing.')
        }
        operationResult = await reprocessSubmission(history.submission, context)
        if (operationResult?.status !== 'review_ready') {
          await store.updateSubmissionStatus?.({
            submissionId: claimed.submissionId,
            status: 'confirmed',
            allowedStatuses: ['failed', 'processing'],
          }).catch(() => undefined)
          throw new Error('The round screenshots could not be reprocessed safely.')
        }
        historyStateChanged = operationResult?.status === 'review_ready'
      }
      const derived = await postMutation(
        actorUserId,
        claimed.operationKind,
        clearAllRounds ? 'all four rounds' : claimed.round,
        { skipMvpPreview: clearAllRounds },
      )
      return store.completeAdminOperation({
        operationId: claimed.operationId,
        expectedVersion: claimed.reviewVersion,
        relatedSheetAuditId,
        relatedOperationId: claimed.relatedOperationId,
        afterSnapshot,
        verification,
        result: { ...operationResult, ...derived },
        sheetWriteApplied,
        historyStateChanged,
      })
    } catch (reason) {
      await store.failAdminOperation({
        operationId: claimed.operationId,
        expectedVersion: claimed.reviewVersion,
        afterSnapshot,
        verification,
        result: null,
        sheetWriteApplied,
        historyStateChanged,
        error: compactError(reason),
      }).catch(() => undefined)
      throw reason
    }
  }

  async function cancelOperation(operation, actorUserId) {
    return store.cancelAdminOperation({
      operationId: operation.operationId,
      actorUserId,
      expectedVersion: operation.reviewVersion,
    })
  }

  return {
    initialize,
    prepareOperation,
    attachMessage,
    findOperation,
    executeOperation,
    cancelOperation,
    config: sheetService.config,
  }
}
