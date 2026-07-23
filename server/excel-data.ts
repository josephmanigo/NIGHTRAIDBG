import { z } from 'zod'
import type { AiEvaluationRow, ApplicationDecisionRow, ClanApplicationRow } from './database.types.js'
import { getSupabaseAdmin } from './supabase.js'

const applicationStatuses = [
  'SUBMITTED',
  'PROCESSING',
  'PENDING_REVIEW',
  'APPROVED',
  'REJECTED',
  'DISCORD_JOIN_FAILED',
  'COMPLETED',
  'REMOVED',
  'LEFT',
] as const
const games = ['Mobile Legends', 'Bloodstrike', 'Farlight'] as const

export const excelExportFiltersSchema = z.object({
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  status: z.enum(applicationStatuses).optional(),
  game: z.enum(games).optional(),
  ageGroup: z.enum(['UNDER_18', 'AGE_18_OR_ABOVE']).optional(),
  device: z.enum(['PC', 'Mobile']).optional(),
  recommendation: z.enum(['RECOMMENDED', 'MANUAL_REVIEW', 'NOT_RECOMMENDED']).optional(),
  decision: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(),
  recruitmentSource: z.enum(['Facebook', 'TikTok', 'Discord', 'Others']).optional(),
  onboardingStatus: z.enum(['NOT_STARTED', 'PROCESSING', 'COMPLETED', 'FAILED']).optional(),
  applicationIds: z.array(z.string().uuid()).min(1).max(500).optional(),
}).strict()

export type ExcelExportFilters = z.infer<typeof excelExportFiltersSchema>

function queryValue(value: string | string[] | undefined) {
  const result = Array.isArray(value) ? value[0] : value
  return result?.trim() || undefined
}

export function parseExcelQueryFilters(query: Record<string, string | string[] | undefined>) {
  return excelExportFiltersSchema.safeParse({
    dateFrom: queryValue(query.dateFrom),
    dateTo: queryValue(query.dateTo),
    status: queryValue(query.status),
    game: queryValue(query.game),
    ageGroup: queryValue(query.ageGroup),
    device: queryValue(query.device),
    recommendation: queryValue(query.recommendation),
    decision: queryValue(query.decision),
    recruitmentSource: queryValue(query.recruitmentSource),
    onboardingStatus: queryValue(query.onboardingStatus),
  })
}

export interface ExcelApplicationRecord {
  application: ClanApplicationRow
  evaluation: AiEvaluationRow | null
  decision: ApplicationDecisionRow | null
}

function chunks<T>(items: T[], size: number) {
  const result: T[][] = []
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size))
  return result
}

async function loadApplications() {
  const supabase = getSupabaseAdmin()
  const applications: ClanApplicationRow[] = []
  const pageSize = 1000
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('clan_applications')
      .select('*')
      .order('submitted_at', { ascending: false })
      .range(from, from + pageSize - 1)
    if (error) throw new Error(`Applications could not be loaded for Excel: ${error.message}`)
    applications.push(...(data ?? []))
    if (!data || data.length < pageSize) break
  }
  return applications
}

async function loadEvaluations(applicationIds: string[]) {
  const supabase = getSupabaseAdmin()
  const latest = new Map<string, AiEvaluationRow>()
  for (const applicationIdChunk of chunks(applicationIds, 200)) {
    const { data, error } = await supabase
      .from('ai_evaluations')
      .select('*')
      .in('application_id', applicationIdChunk)
      .order('created_at', { ascending: false })
    if (error) throw new Error(`AI evaluations could not be loaded for Excel: ${error.message}`)
    for (const evaluation of data ?? []) {
      if (!latest.has(evaluation.application_id)) latest.set(evaluation.application_id, evaluation)
    }
  }
  return latest
}

async function loadDecisions(applicationIds: string[]) {
  const supabase = getSupabaseAdmin()
  const latest = new Map<string, ApplicationDecisionRow>()
  for (const applicationIdChunk of chunks(applicationIds, 200)) {
    const { data, error } = await supabase
      .from('application_decisions')
      .select('*')
      .in('application_id', applicationIdChunk)
      .order('decided_at', { ascending: false })
    if (error) throw new Error(`Application decisions could not be loaded for Excel: ${error.message}`)
    for (const decision of data ?? []) {
      if (!latest.has(decision.application_id)) latest.set(decision.application_id, decision)
    }
  }
  return latest
}

export function finalDecision(application: ClanApplicationRow) {
  if (application.status === 'REJECTED') return 'REJECTED'
  /* REMOVED and LEFT members were approved before exiting, so the register
   * keeps the original application decision; the status column records the exit. */
  if (['APPROVED', 'DISCORD_JOIN_FAILED', 'COMPLETED', 'REMOVED', 'LEFT'].includes(application.status)) return 'APPROVED'
  return 'PENDING'
}

function matchesFilters(record: ExcelApplicationRecord, filters: ExcelExportFilters) {
  const { application, evaluation } = record
  if (filters.applicationIds && !filters.applicationIds.includes(application.id)) return false
  if (filters.status && application.status !== filters.status) return false
  if (filters.game && !application.games.includes(filters.game)) return false
  if (filters.ageGroup && application.age_group !== filters.ageGroup) return false
  if (filters.device && application.device !== filters.device) return false
  if (filters.recommendation && evaluation?.recommendation !== filters.recommendation) return false
  if (filters.decision && finalDecision(application) !== filters.decision) return false
  if (filters.recruitmentSource && application.discovery_source !== filters.recruitmentSource) return false
  if (filters.onboardingStatus && application.discord_onboarding_status !== filters.onboardingStatus) return false

  const submittedAt = new Date(application.submitted_at).getTime()
  if (filters.dateFrom && submittedAt < new Date(`${filters.dateFrom}T00:00:00.000Z`).getTime()) return false
  if (filters.dateTo && submittedAt > new Date(`${filters.dateTo}T23:59:59.999Z`).getTime()) return false
  return true
}

export async function loadExcelRecords(filters: ExcelExportFilters = {}) {
  const applications = await loadApplications()
  if (applications.length === 0) return []
  const applicationIds = applications.map((application) => application.id)
  const [evaluations, decisions] = await Promise.all([
    loadEvaluations(applicationIds),
    loadDecisions(applicationIds),
  ])
  return applications
    .map((application): ExcelApplicationRecord => ({
      application,
      evaluation: evaluations.get(application.id) ?? null,
      decision: decisions.get(application.id) ?? null,
    }))
    .filter((record) => matchesFilters(record, filters))
}

export function filtersForAudit(filters: ExcelExportFilters) {
  return Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== undefined))
}

export function hasExportFilters(filters: ExcelExportFilters) {
  return Object.keys(filtersForAudit(filters)).length > 0
}
