import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const MIGRATION_URL = new URL('../database/phase9.sql', import.meta.url)
const REVIEW_MIGRATION_URL = new URL('../database/phase10.sql', import.meta.url)
const SHEET_WRITE_MIGRATION_URL = new URL('../database/phase11.sql', import.meta.url)
const PRODUCTION_WRITE_MIGRATION_URL = new URL('../database/phase12.sql', import.meta.url)
const PLAYER_HISTORY_MIGRATION_URL = new URL('../database/phase13.sql', import.meta.url)
const MVP_MIGRATION_URL = new URL('../database/phase14.sql', import.meta.url)
const ADMIN_MIGRATION_URL = new URL('../database/phase15.sql', import.meta.url)
const SCREENSHOT_DELETION_MIGRATION_URL = new URL('../database/phase16.sql', import.meta.url)

test('defines the persistent submission schema and every required status', async () => {
  const sql = await readFile(MIGRATION_URL, 'utf8')
  for (const status of [
    'pending',
    'processing',
    'needs_review',
    'confirmed',
    'corrected',
    'rejected',
    'duplicate',
    'failed',
    'deleted',
  ]) {
    assert.match(sql, new RegExp(`'${status}'`))
  }
  assert.match(sql, /create table if not exists public\.game_result_submissions/i)
  assert.match(sql, /create table if not exists public\.game_result_screenshots/i)
  assert.match(sql, /submission_id uuid not null references public\.game_result_submissions/i)
})

test('adds persistent Discord review state and approved-for-writing status', async () => {
  const sql = await readFile(REVIEW_MIGRATION_URL, 'utf8')
  assert.match(sql, /add value if not exists 'approved_for_writing'/i)
  for (const column of [
    'review_payload',
    'review_message_id',
    'review_page',
    'review_version',
    'review_updated_by',
    'review_updated_at',
    'confirmed_by',
    'confirmed_at',
  ]) {
    assert.match(sql, new RegExp(`add column if not exists ${column}`, 'i'))
  }
  assert.doesNotMatch(sql, /sheets\.googleapis\.com|spreadsheets\.values\.(?:update|append)/i)
})

test('adds a service-role-only sheet-write audit with rollback backup fields', async () => {
  const sql = await readFile(SHEET_WRITE_MIGRATION_URL, 'utf8')
  assert.match(sql, /create table if not exists public\.game_result_sheet_write_audits/i)
  assert.match(sql, /worksheet_name text not null check \(worksheet_name = 'Copy of New'\)/i)
  for (const column of [
    'target_cells',
    'before_snapshot',
    'after_snapshot',
    'write_payload',
    'verification',
    'sheet_write_applied',
    'rolled_back_by',
    'rolled_back_at',
  ]) assert.match(sql, new RegExp(`${column}`, 'i'))
  assert.match(sql, /grant select, insert, update[\s\S]*to service_role/i)
  assert.match(sql, /revoke all[\s\S]*from anon, authenticated/i)
})

test('adds explicit score-sheet modes and guarded production corrections', async () => {
  const sql = await readFile(PRODUCTION_WRITE_MIGRATION_URL, 'utf8')
  assert.match(sql, /worksheet_name in \('Copy of New', 'New'\)/i)
  assert.match(sql, /score_sheet_mode = 'test' and worksheet_name = 'Copy of New'/i)
  assert.match(sql, /score_sheet_mode = 'production' and worksheet_name = 'New'/i)
  for (const column of [
    'score_sheet_mode',
    'write_kind',
    'supersedes_audit_id',
    'correction_authorized_by',
  ]) assert.match(sql, new RegExp(column, 'i'))
  assert.match(sql, /game_result_sheet_write_initial_round_idx/i)
  assert.match(sql, /game_result_sheet_write_active_operation_idx/i)
  assert.match(sql, /game_result_sheet_write_correction_chain_idx/i)
})

test('adds append-only player history for every team with correction revisions', async () => {
  const sql = await readFile(PLAYER_HISTORY_MIGRATION_URL, 'utf8')
  assert.match(sql, /create table if not exists public\.game_result_history_snapshots/i)
  assert.match(sql, /create table if not exists public\.game_result_player_history/i)
  for (const column of [
    'submission_id',
    'round_number',
    'rank',
    'team_code',
    'official_team_name',
    'team_total_kills',
    'player_slot',
    'player_name',
    'player_kills',
    'confidence',
    'validation_status',
    'screenshot_url',
    'discord_message_url',
    'submitted_by',
    'approved_by',
    'recorded_at',
  ]) assert.match(sql, new RegExp(column, 'i'))
  assert.match(sql, /record_game_result_player_history/i)
  assert.match(sql, /rollback_game_result_player_history/i)
  assert.match(sql, /record_status = 'superseded'/i)
  assert.match(sql, /game_result_player_history_active_slot_idx/i)
  assert.match(
    sql,
    /history\.record_status = 'active'[\s\S]*submission\.status = 'confirmed'[\s\S]*submission\.status not in \('rejected', 'deleted'\)/i,
  )
  assert.match(sql, /revoke all[\s\S]*from anon, authenticated/i)
  assert.doesNotMatch(sql, /BOT_RAW_RESULTS|batchUpdate|sheets\.googleapis\.com/i)
})

test('adds persistent overall-champion MVP previews and write audits', async () => {
  const sql = await readFile(MVP_MIGRATION_URL, 'utf8')
  assert.match(sql, /create table if not exists public\.game_result_mvp_reviews/i)
  for (const column of [
    'source_fingerprint',
    'source_snapshots',
    'champion',
    'roster',
    'issues',
    'before_snapshot',
    'after_snapshot',
    'write_payload',
    'verification',
    'sheet_write_applied',
  ]) assert.match(sql, new RegExp(column, 'i'))
  assert.match(sql, /production_worksheet_name = 'New'/i)
  assert.match(sql, /mvp_worksheet_name = 'FINALS • MVP'/i)
  assert.match(sql, /game_result_mvp_active_source_idx/i)
  assert.match(sql, /where status in \('processing', 'confirmed'\)/i)
  assert.match(sql, /revoke all[\s\S]*from anon, authenticated/i)
  assert.doesNotMatch(sql, /batchUpdate|sheets\.googleapis\.com/i)
})

test('adds append-only administrative correction and rollback audits', async () => {
  const sql = await readFile(ADMIN_MIGRATION_URL, 'utf8')
  assert.match(sql, /create table if not exists public\.game_result_admin_operations/i)
  for (const operation of [
    'edit_round',
    'delete_round',
    'restore_round',
    'reprocess_round',
    'rollback_update',
    'sync_score_sheet',
  ]) assert.match(sql, new RegExp(`'${operation}'`, 'i'))
  for (const column of [
    'requested_changes',
    'preview',
    'before_snapshot',
    'after_snapshot',
    'verification',
    'result',
    'confirmed_by',
    'cancelled_by',
  ]) assert.match(sql, new RegExp(column, 'i'))
  assert.match(sql, /record_status in \('active', 'superseded', 'rolled_back', 'deleted'\)/i)
  assert.match(sql, /delete_game_result_round_history/i)
  assert.match(sql, /restore_game_result_round_history/i)
  assert.match(sql, /worksheet_name text not null check \(worksheet_name = 'New'\)/i)
  assert.match(sql, /status in \('processing', 'confirmed'\) and invalidated_at is null/i)
  assert.match(sql, /revoke all[\s\S]*from anon, authenticated/i)
  assert.doesNotMatch(sql, /\bdelete\s+from\b/i)
  assert.doesNotMatch(sql, /sheets\.googleapis\.com|batchUpdate/i)
})

test('makes only canonical SHA-256 hashes unique, not perceptual hashes', async () => {
  const sql = await readFile(MIGRATION_URL, 'utf8')
  assert.match(
    sql,
    /create unique index if not exists game_result_screenshots_canonical_sha256_idx[\s\S]*where status not in \('duplicate', 'deleted'\)/i,
  )
  assert.match(
    sql,
    /create index if not exists game_result_screenshots_perceptual_hash_idx[\s\S]*\(perceptual_hash\)/i,
  )
  assert.doesNotMatch(sql, /create unique index[^\n]*perceptual_hash/i)
})

test('releases deleted Discord screenshots without erasing confirmed score audits', async () => {
  const sql = await readFile(SCREENSHOT_DELETION_MIGRATION_URL, 'utf8')
  assert.match(sql, /tombstone_deleted_game_result_message/i)
  assert.match(sql, /where status not in \('duplicate', 'deleted'\)/i)
  assert.match(sql, /screenshot_url = ''/i)
  assert.match(sql, /filename = '\[deleted Discord screenshot\]'/i)
  assert.match(sql, /sha256 = encode\(digest\('deleted-sha256:'/i)
  assert.match(sql, /status = 'deleted'/i)
  assert.match(sql, /when v_submission\.status::text in \('confirmed', 'corrected'\)/i)
  assert.match(sql, /grant execute[\s\S]*to service_role/i)
  assert.doesNotMatch(sql, /\bdelete\s+from\b/i)
})
