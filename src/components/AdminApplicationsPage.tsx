import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, Ban, Check, Download, FileSpreadsheet, History, MessageCircle, RefreshCw, ShieldAlert, Sparkles, X } from 'lucide-react'
import PortalShell from './PortalShell'

interface AdminSession {
  connected: boolean
  discordUsername?: string
  isAdmin?: boolean
}

interface AdminApplication {
  id: string
  application_number: string
  discord_username: string
  in_game_name: string
  age_group: string
  sex: string
  device: string
  games: string[]
  willing_to_use_clan_tag: boolean
  play_frequency: string
  previous_clan: string
  previous_clan_leaving_reason: string
  facebook_profile_url: string
  discovery_source: string
  discovery_source_other: string | null
  already_joined_discord: boolean
  discord_membership_verified: boolean | null
  reason_for_joining: string
  status: string
  decision_reason: string | null
  discord_onboarding_status: string
  assigned_discord_roles: string[]
  discord_onboarded_at: string | null
  discord_onboarding_error: string | null
  ai_evaluation_status: string
  ai_evaluation_error: string | null
  ai_evaluated_at: string | null
  ai_evaluation: AiEvaluation | null
  messenger_notification_status: string
  messenger_notification_error: string | null
  messenger_notified_at: string | null
  messenger_message_ids: string[]
  excel_sync_status: string
  excel_synced_at: string | null
  excel_sync_error: string | null
  submitted_at: string
  reviewed_at: string | null
}

interface AiEvaluation {
  score: number
  recommendation: string
  confidence: number
  motivation_score: number
  teamwork_score: number
  activity_score: number
  clan_commitment_score: number
  consistency_score: number
  communication_score: number
  strengths: string[]
  concerns: string[]
  summary: string
  moderation_flagged: boolean
  model: string
  prompt_version: string
  created_at: string
}

interface ExcelFilters {
  dateFrom: string
  dateTo: string
  status: string
  game: string
  ageGroup: string
  device: string
  recommendation: string
  decision: string
  recruitmentSource: string
  onboardingStatus: string
}

interface ExcelStatus {
  counts: Record<string, number>
  latestSync: {
    status: string
    record_count: number
    error_message: string | null
    created_at: string
  } | null
  downloadUrl: string | null
}

interface ClanBan {
  id: string
  discord_user_id: string | null
  in_game_name: string | null
  facebook_profile_url: string | null
  reason: string
  is_active: boolean
  banned_by: string
  created_at: string
  deactivated_at: string | null
}

interface SecurityAuditLog {
  id: string
  actor_type: string
  actor_id: string | null
  action: string
  outcome: string
  target_type: string | null
  target_id: string | null
  created_at: string
}

interface SecurityData {
  bans: ClanBan[]
  auditLogs: SecurityAuditLog[]
}

const emptyFilters: ExcelFilters = {
  dateFrom: '',
  dateTo: '',
  status: '',
  game: '',
  ageGroup: '',
  device: '',
  recommendation: '',
  decision: '',
  recruitmentSource: '',
  onboardingStatus: '',
}

function readable(value: string) {
  return value.split('_').join(' ')
}

function finalDecision(application: AdminApplication) {
  if (application.status === 'REJECTED') return 'REJECTED'
  if (['APPROVED', 'DISCORD_JOIN_FAILED', 'COMPLETED'].includes(application.status)) return 'APPROVED'
  return 'PENDING'
}

function activeFilters(filters: ExcelFilters) {
  return Object.fromEntries(Object.entries(filters).filter(([, value]) => value))
}

async function downloadResponse(response: Response) {
  if (!response.ok) {
    const contentType = response.headers.get('content-type') || ''
    const payload = contentType.includes('application/json') ? await response.json() as { message?: string } : null
    throw new Error(payload?.message || 'The Excel workbook could not be downloaded.')
  }
  const blob = await response.blob()
  const disposition = response.headers.get('content-disposition') || ''
  const name = disposition.match(/filename="([^"]+)"/)?.[1] || 'NightRaid_Applicants.xlsx'
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-bone/10 py-4 last:border-b-0">
      <dt className="ln-label text-[0.52rem] text-bone/35">{label}</dt>
      <dd className="mt-2 text-sm leading-relaxed text-bone/70">{children}</dd>
    </div>
  )
}

function FilterSelect({ label, value, onChange, children }: {
  label: string
  value: string
  onChange: (value: string) => void
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <span className="ln-label text-[0.48rem] text-bone/35">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-2 h-10 w-full rounded-xl border border-bone/10 bg-black/40 px-3 text-xs text-bone outline-none transition-colors focus:border-blood"
      >
        <option value="">All</option>
        {children}
      </select>
    </label>
  )
}

export default function AdminApplicationsPage() {
  const [session, setSession] = useState<AdminSession | null>(null)
  const [applications, setApplications] = useState<AdminApplication[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [selectedRows, setSelectedRows] = useState<string[]>([])
  const [filters, setFilters] = useState<ExcelFilters>(emptyFilters)
  const [excelStatus, setExcelStatus] = useState<ExcelStatus | null>(null)
  const [securityData, setSecurityData] = useState<SecurityData | null>(null)
  const [securityBusy, setSecurityBusy] = useState(false)
  const [excelBusy, setExcelBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [acting, setActing] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const loadApplications = useCallback(async () => {
    const response = await fetch('/api/admin/applications', { credentials: 'same-origin' })
    if (!(response.headers.get('content-type') || '').includes('application/json')) {
      throw new Error('The server API is not running. Start the site with npm run dev:full.')
    }
    const payload = (await response.json()) as { applications?: AdminApplication[]; message?: string }
    if (!response.ok) throw new Error(payload.message || 'Unable to load applications.')
    const next = payload.applications ?? []
    setApplications(next)
    setSelectedId((current) => {
      if (next.some((item) => item.id === current)) return current
      const requested = new URLSearchParams(window.location.search).get('application')
      return next.find((item) => item.id === requested)?.id ?? next[0]?.id ?? ''
    })
  }, [])

  const loadExcelStatus = useCallback(async () => {
    const response = await fetch('/api/admin/applications/excel-status', { credentials: 'same-origin' })
    if (!response.ok || !(response.headers.get('content-type') || '').includes('application/json')) {
      setExcelStatus(null)
      return
    }
    setExcelStatus(await response.json() as ExcelStatus)
  }, [])

  const loadSecurity = useCallback(async () => {
    const response = await fetch('/api/admin/security', { credentials: 'same-origin' })
    if (!response.ok || !(response.headers.get('content-type') || '').includes('application/json')) {
      setSecurityData(null)
      return
    }
    setSecurityData(await response.json() as SecurityData)
  }, [])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const response = await fetch('/api/auth/session', { credentials: 'same-origin' })
        if (!response.ok) throw new Error('Unable to verify the administrator session.')
        if (!(response.headers.get('content-type') || '').includes('application/json')) {
          throw new Error('The server API is not running. Start the site with npm run dev:full.')
        }
        const nextSession = (await response.json()) as AdminSession
        if (cancelled) return
        setSession(nextSession)
        if (nextSession.connected && nextSession.isAdmin) {
          await Promise.all([loadApplications(), loadExcelStatus(), loadSecurity()])
        }
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : 'Unable to load the administrator portal.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [loadApplications, loadExcelStatus, loadSecurity])

  const selected = useMemo(
    () => applications.find((application) => application.id === selectedId) ?? null,
    [applications, selectedId],
  )

  const filteredApplications = useMemo(() => applications.filter((application) => {
    if (filters.status && application.status !== filters.status) return false
    if (filters.game && !application.games.includes(filters.game)) return false
    if (filters.ageGroup && application.age_group !== filters.ageGroup) return false
    if (filters.device && application.device !== filters.device) return false
    if (filters.recommendation && application.ai_evaluation?.recommendation !== filters.recommendation) return false
    if (filters.decision && finalDecision(application) !== filters.decision) return false
    if (filters.recruitmentSource && application.discovery_source !== filters.recruitmentSource) return false
    if (filters.onboardingStatus && application.discord_onboarding_status !== filters.onboardingStatus) return false
    const submittedAt = new Date(application.submitted_at).getTime()
    if (filters.dateFrom && submittedAt < new Date(`${filters.dateFrom}T00:00:00`).getTime()) return false
    if (filters.dateTo && submittedAt > new Date(`${filters.dateTo}T23:59:59.999`).getTime()) return false
    return true
  }), [applications, filters])

  const decide = async (decision: 'approve' | 'reject') => {
    if (!selected || acting) return
    let reason = ''
    if (decision === 'reject') {
      const answer = window.prompt('Enter the rejection reason:')
      if (answer === null) return
      reason = answer.trim()
      if (reason.length < 2) {
        setError('Enter a clear rejection reason before continuing.')
        return
      }
    } else if (!window.confirm(`Approve ${selected.in_game_name}?`)) {
      return
    }

    setActing(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch(`/api/admin/applications/${selected.id}/${decision}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(decision === 'reject' ? { reason } : {}),
      })
      if (!(response.headers.get('content-type') || '').includes('application/json')) {
        throw new Error('The server API returned an invalid response.')
      }
      const payload = (await response.json()) as { message?: string; onboarding?: { status?: string } }
      if (!response.ok) {
        await loadApplications()
        throw new Error(payload.message || `Unable to ${decision} this application.`)
      }
      await loadApplications()
      if (payload.onboarding?.status === 'DISCORD_JOIN_FAILED') {
        setError(payload.message || 'The application was approved, but Discord onboarding needs a retry.')
      } else {
        setNotice(payload.message || `Application ${decision === 'approve' ? 'approved' : 'rejected'}.`)
      }
    } catch (reasonValue) {
      setError(reasonValue instanceof Error ? reasonValue.message : 'The decision could not be saved.')
    } finally {
      setActing(false)
    }
  }

  const retryDiscord = async () => {
    if (!selected || acting) return
    setActing(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch(`/api/admin/applications/${selected.id}/retry-discord`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      if (!(response.headers.get('content-type') || '').includes('application/json')) {
        throw new Error('The server API returned an invalid response.')
      }
      const payload = (await response.json()) as { message?: string; onboarding?: { status?: string } }
      await loadApplications()
      if (!response.ok) throw new Error(payload.message || 'Discord onboarding could not be retried.')
      if (payload.onboarding?.status === 'DISCORD_JOIN_FAILED') {
        setError(payload.message || 'Discord onboarding failed again.')
      } else {
        setNotice(payload.message || 'Discord onboarding completed.')
      }
    } catch (reasonValue) {
      setError(reasonValue instanceof Error ? reasonValue.message : 'Discord onboarding could not be retried.')
    } finally {
      setActing(false)
    }
  }

  const retryEvaluation = async () => {
    if (!selected || acting) return
    setActing(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch(`/api/admin/applications/${selected.id}/retry-evaluation`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      if (!(response.headers.get('content-type') || '').includes('application/json')) {
        throw new Error('The server API returned an invalid response.')
      }
      const payload = (await response.json()) as { message?: string }
      await loadApplications()
      if (!response.ok) throw new Error(payload.message || 'AI review could not be retried.')
      setNotice(payload.message || 'AI recommendation refreshed.')
    } catch (reasonValue) {
      setError(reasonValue instanceof Error ? reasonValue.message : 'AI review could not be retried.')
    } finally {
      setActing(false)
    }
  }

  const retryMessenger = async () => {
    if (!selected || acting) return
    setActing(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch(`/api/admin/applications/${selected.id}/retry-messenger`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      if (!(response.headers.get('content-type') || '').includes('application/json')) {
        throw new Error('The server API returned an invalid response.')
      }
      const payload = (await response.json()) as { message?: string }
      await loadApplications()
      if (!response.ok) throw new Error(payload.message || 'Messenger notification could not be retried.')
      setNotice(payload.message || 'Messenger notification delivered.')
    } catch (reasonValue) {
      setError(reasonValue instanceof Error ? reasonValue.message : 'Messenger notification could not be retried.')
    } finally {
      setActing(false)
    }
  }

  const updateFilter = (key: keyof ExcelFilters, value: string) => {
    setFilters((current) => ({ ...current, [key]: value }))
  }

  const toggleSelectedRow = (applicationId: string) => {
    setSelectedRows((current) => current.includes(applicationId)
      ? current.filter((id) => id !== applicationId)
      : [...current, applicationId])
  }

  const toggleVisibleRows = () => {
    const visibleIds = filteredApplications.map((application) => application.id)
    const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedRows.includes(id))
    setSelectedRows((current) => allSelected
      ? current.filter((id) => !visibleIds.includes(id))
      : [...new Set([...current, ...visibleIds])])
  }

  const exportExcel = async (mode: 'all' | 'filtered' | 'selected') => {
    if (excelBusy) return
    if (mode === 'selected' && selectedRows.length === 0) {
      setError('Select at least one application before exporting selected records.')
      return
    }
    setExcelBusy(true)
    setError('')
    setNotice('')
    try {
      const body = mode === 'all'
        ? {}
        : mode === 'filtered'
          ? activeFilters(filters)
          : { applicationIds: selectedRows }
      const response = await fetch('/api/admin/applications/export', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      await downloadResponse(response)
      setNotice(mode === 'selected'
        ? `${selectedRows.length} selected applications exported to Excel.`
        : mode === 'filtered'
          ? 'Filtered applications exported to Excel.'
          : 'All applications exported to Excel.')
    } catch (reasonValue) {
      setError(reasonValue instanceof Error ? reasonValue.message : 'The Excel workbook could not be downloaded.')
    } finally {
      setExcelBusy(false)
    }
  }

  const syncExcel = async (applicationIds?: string[]) => {
    if (excelBusy) return
    setExcelBusy(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/admin/applications/sync-excel', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(applicationIds?.length ? { applicationIds } : {}),
      })
      const payload = await response.json() as { message?: string }
      await Promise.all([loadApplications(), loadExcelStatus()])
      if (!response.ok) throw new Error(payload.message || 'Excel synchronization failed safely.')
      setNotice(payload.message || 'Excel applicant register synchronized.')
    } catch (reasonValue) {
      setError(reasonValue instanceof Error ? reasonValue.message : 'Excel synchronization could not be completed.')
    } finally {
      setExcelBusy(false)
    }
  }

  const banSelectedApplicant = async () => {
    if (!selected || securityBusy) return
    const answer = window.prompt(`Why should ${selected.in_game_name} be blocked from applying?`)
    if (answer === null) return
    const reason = answer.trim()
    if (reason.length < 2) {
      setError('Enter a clear ban reason before continuing.')
      return
    }
    if (!window.confirm(`Activate a ban for ${selected.in_game_name}?`)) return

    setSecurityBusy(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/admin/bans', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ applicationId: selected.id, reason }),
      })
      const payload = await response.json() as { message?: string }
      if (!response.ok) throw new Error(payload.message || 'Unable to activate the applicant ban.')
      await loadSecurity()
      setNotice(payload.message || 'Applicant ban activated.')
    } catch (reasonValue) {
      setError(reasonValue instanceof Error ? reasonValue.message : 'Unable to activate the applicant ban.')
    } finally {
      setSecurityBusy(false)
    }
  }

  const deactivateBan = async (ban: ClanBan) => {
    if (securityBusy || !window.confirm(`Deactivate the ban for ${ban.in_game_name || ban.discord_user_id || 'this applicant'}?`)) return
    setSecurityBusy(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch(`/api/admin/bans/${ban.id}/deactivate`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      const payload = await response.json() as { message?: string }
      if (!response.ok) throw new Error(payload.message || 'Unable to deactivate the ban.')
      await loadSecurity()
      setNotice(payload.message || 'Applicant ban deactivated.')
    } catch (reasonValue) {
      setError(reasonValue instanceof Error ? reasonValue.message : 'Unable to deactivate the ban.')
    } finally {
      setSecurityBusy(false)
    }
  }

  return (
    <PortalShell
      eyebrow="Authorized access"
      title="Application"
      accent="command"
      kicker="Review complete applications and record the final NightRaid administrator decision."
      showHeaderDivider={false}
    >
      {loading ? (
        <div className="rounded-[2rem] border border-bone/10 bg-black/30 p-10 text-center text-sm text-bone/45">Verifying administrator access...</div>
      ) : error && !session ? (
        <div className="flex items-start gap-3 rounded-2xl border border-red-400/25 bg-red-400/5 p-5 text-sm text-red-200">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
        </div>
      ) : !session?.connected ? (
        <div className="rounded-[2rem] border border-[#5865F2]/30 bg-[#5865F2]/10 p-7 sm:p-10">
          <h2 className="font-display text-3xl uppercase text-bone">Administrator login</h2>
          <p className="mt-3 text-sm text-bone/50">Connect an authorized Discord account to open the review queue.</p>
          <a href="/api/auth/discord?returnTo=%2Fadmin%2Fapplications" className="mt-7 inline-flex h-11 items-center rounded-full bg-[#5865F2] px-6 text-[0.65rem] font-extrabold uppercase tracking-[0.12em] text-white">Continue with Discord</a>
        </div>
      ) : !session.isAdmin ? (
        <div className="flex items-start gap-4 rounded-[2rem] border border-red-400/25 bg-red-400/5 p-7 sm:p-10">
          <ShieldAlert className="h-6 w-6 shrink-0 text-red-300" />
          <div>
            <h2 className="font-display text-3xl uppercase text-bone">Access denied</h2>
            <p className="mt-3 text-sm text-bone/50">{session.discordUsername} is not listed in ADMIN_DISCORD_IDS.</p>
          </div>
        </div>
      ) : (
        <>
          {error && (
            <div className="mb-5 flex items-start gap-3 rounded-2xl border border-red-400/25 bg-red-400/5 p-4 text-sm text-red-200">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
            </div>
          )}

          {notice && (
            <div className="mb-5 flex items-start gap-3 rounded-2xl border border-emerald-400/25 bg-emerald-400/5 p-4 text-sm text-emerald-200">
              <Check className="mt-0.5 h-4 w-4 shrink-0" /> {notice}
            </div>
          )}

          <section className="mb-5 rounded-[2rem] border border-white/10 bg-white/[0.035] p-5 shadow-[0_24px_80px_rgba(0,0,0,0.28)] backdrop-blur-2xl sm:p-7">
            <details>
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4">
                <span className="flex items-center gap-2 ln-label text-[0.55rem] text-bone/45"><ShieldAlert className="h-4 w-4" /> Security and audit</span>
                <span className="text-xs text-bone/35">
                  {securityData ? `${securityData.bans.filter((ban) => ban.is_active).length} active bans · ${securityData.auditLogs.length} recent events` : 'Phase 7 database setup required'}
                </span>
              </summary>

              <div className="mt-6 grid gap-5 border-t border-bone/10 pt-6 xl:grid-cols-2">
                <div>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="ln-label text-[0.5rem] text-bone/45">Applicant bans</p>
                      <p className="mt-2 text-xs leading-relaxed text-bone/35">A ban matches Discord ID, in-game name, or Facebook profile before a new application is saved.</p>
                    </div>
                    <button type="button" disabled={!selected || securityBusy} onClick={() => void banSelectedApplicant()} className="inline-flex h-9 items-center gap-2 rounded-full border border-red-300/30 px-4 text-[0.55rem] font-extrabold uppercase tracking-[0.1em] text-red-200 disabled:opacity-35">
                      <Ban className="h-3.5 w-3.5" /> Ban selected
                    </button>
                  </div>
                  <div className="mt-4 max-h-64 space-y-2 overflow-y-auto pr-1">
                    {securityData?.bans.filter((ban) => ban.is_active).map((ban) => (
                      <div key={ban.id} className="rounded-xl border border-white/10 bg-white/[0.025] p-4 backdrop-blur-xl">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-bold text-bone">{ban.in_game_name || ban.discord_user_id || 'Facebook applicant'}</p>
                            <p className="mt-1 break-words text-xs text-bone/35">{ban.reason}</p>
                            <p className="mt-2 text-[0.58rem] uppercase tracking-[0.08em] text-bone/25">{new Date(ban.created_at).toLocaleString()}</p>
                          </div>
                          <button type="button" disabled={securityBusy} onClick={() => void deactivateBan(ban)} className="shrink-0 rounded-full border border-bone/15 px-3 py-1.5 text-[0.5rem] font-bold uppercase tracking-[0.08em] text-bone/45 disabled:opacity-40">Deactivate</button>
                        </div>
                      </div>
                    ))}
                    {securityData && securityData.bans.every((ban) => !ban.is_active) && <p className="rounded-xl border border-bone/10 p-4 text-xs text-bone/35">No active applicant bans.</p>}
                    {!securityData && <p className="rounded-xl border border-white/10 bg-black/20 p-4 text-xs text-bone/55">Run database/phase7.sql in Supabase, then refresh this page.</p>}
                  </div>
                </div>

                <div>
                  <p className="flex items-center gap-2 ln-label text-[0.5rem] text-bone/45"><History className="h-3.5 w-3.5" /> Recent audit history</p>
                  <div className="mt-4 max-h-64 space-y-2 overflow-y-auto pr-1">
                    {securityData?.auditLogs.slice(0, 30).map((entry) => (
                      <div key={entry.id} className="flex items-start justify-between gap-4 rounded-xl border border-white/10 bg-white/[0.025] p-3 backdrop-blur-xl">
                        <div className="min-w-0">
                          <p className="truncate text-xs font-bold uppercase tracking-[0.06em] text-bone/65">{readable(entry.action)}</p>
                          <p className="mt-1 truncate text-[0.6rem] text-bone/30">{entry.actor_type}{entry.actor_id ? ` · ${entry.actor_id}` : ''}</p>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className={entry.outcome === 'SUCCESS' ? 'text-[0.55rem] text-emerald-300' : 'text-[0.55rem] text-amber-200'}>{entry.outcome}</p>
                          <p className="mt-1 text-[0.55rem] text-bone/25">{new Date(entry.created_at).toLocaleString()}</p>
                        </div>
                      </div>
                    ))}
                    {securityData && securityData.auditLogs.length === 0 && <p className="rounded-xl border border-bone/10 p-4 text-xs text-bone/35">No security events recorded yet.</p>}
                  </div>
                </div>
              </div>
            </details>
          </section>

          <section className="mb-5 rounded-[2rem] border border-white/10 bg-white/[0.035] p-5 shadow-[0_24px_80px_rgba(0,0,0,0.28)] backdrop-blur-2xl sm:p-7">
            <div className="flex flex-col gap-5 xl:flex-row xl:items-center xl:justify-between">
              <div>
                <p className="flex items-center gap-2 ln-label text-[0.55rem] text-bone/45"><FileSpreadsheet className="h-4 w-4" /> Excel applicant register</p>
                <p className="mt-3 text-sm leading-relaxed text-bone/50">
                  {excelStatus?.latestSync
                    ? `Last master sync: ${new Date(excelStatus.latestSync.created_at).toLocaleString()} · ${excelStatus.latestSync.record_count} records`
                    : 'The private master workbook has not been synchronized yet.'}
                </p>
                {excelStatus && (
                  <div className="mt-3 flex flex-wrap gap-2 text-[0.58rem] font-bold uppercase tracking-[0.08em] text-bone/45">
                    <span>{excelStatus.counts.SYNCED ?? 0} synced</span>
                    <span>·</span>
                    <span>{excelStatus.counts.PENDING ?? 0} pending</span>
                    <span>·</span>
                    <span className={(excelStatus.counts.FAILED ?? 0) > 0 ? 'text-amber-200' : ''}>{excelStatus.counts.FAILED ?? 0} failed</span>
                  </div>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={excelBusy} onClick={() => void exportExcel('all')} className="inline-flex h-10 items-center gap-2 rounded-full bg-emerald-400 px-4 text-[0.58rem] font-extrabold uppercase tracking-[0.1em] text-black disabled:opacity-50">
                  <Download className="h-3.5 w-3.5" /> Export all
                </button>
                <button type="button" disabled={excelBusy} onClick={() => void exportExcel('filtered')} className="inline-flex h-10 items-center gap-2 rounded-full border border-emerald-300/30 px-4 text-[0.58rem] font-extrabold uppercase tracking-[0.1em] text-emerald-200 disabled:opacity-50">
                  <Download className="h-3.5 w-3.5" /> Export filtered
                </button>
                <button type="button" disabled={excelBusy || selectedRows.length === 0} onClick={() => void exportExcel('selected')} className="inline-flex h-10 items-center gap-2 rounded-full border border-bone/15 px-4 text-[0.58rem] font-extrabold uppercase tracking-[0.1em] text-bone/60 disabled:opacity-35">
                  <Download className="h-3.5 w-3.5" /> Selected ({selectedRows.length})
                </button>
                <button type="button" disabled={excelBusy} onClick={() => void syncExcel()} className="inline-flex h-10 items-center gap-2 rounded-full border border-bone/15 px-4 text-[0.58rem] font-extrabold uppercase tracking-[0.1em] text-bone/60 disabled:opacity-50">
                  <RefreshCw className={`h-3.5 w-3.5 ${excelBusy ? 'animate-spin' : ''}`} /> Sync register
                </button>
                {excelStatus?.downloadUrl && (
                  <a href={excelStatus.downloadUrl} className="inline-flex h-10 items-center gap-2 rounded-full border border-sky-300/25 px-4 text-[0.58rem] font-extrabold uppercase tracking-[0.1em] text-sky-200">
                    <FileSpreadsheet className="h-3.5 w-3.5" /> Synced copy
                  </a>
                )}
              </div>
            </div>

            <details className="mt-5 border-t border-bone/10 pt-5">
              <summary className="cursor-pointer ln-label text-[0.55rem] text-bone/55">Export and list filters</summary>
              <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
                <label className="block">
                  <span className="ln-label text-[0.48rem] text-bone/35">Submitted from</span>
                  <input type="date" value={filters.dateFrom} onChange={(event) => updateFilter('dateFrom', event.target.value)} className="mt-2 h-10 w-full rounded-xl border border-bone/10 bg-black/40 px-3 text-xs text-bone outline-none focus:border-blood" />
                </label>
                <label className="block">
                  <span className="ln-label text-[0.48rem] text-bone/35">Submitted to</span>
                  <input type="date" value={filters.dateTo} onChange={(event) => updateFilter('dateTo', event.target.value)} className="mt-2 h-10 w-full rounded-xl border border-bone/10 bg-black/40 px-3 text-xs text-bone outline-none focus:border-blood" />
                </label>
                <FilterSelect label="Application status" value={filters.status} onChange={(value) => updateFilter('status', value)}>
                  {['SUBMITTED', 'PROCESSING', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'DISCORD_JOIN_FAILED', 'COMPLETED'].map((value) => <option key={value} value={value}>{readable(value)}</option>)}
                </FilterSelect>
                <FilterSelect label="Game" value={filters.game} onChange={(value) => updateFilter('game', value)}>
                  {['Mobile Legends', 'Bloodstrike', 'Farlight'].map((value) => <option key={value} value={value}>{value}</option>)}
                </FilterSelect>
                <FilterSelect label="Age group" value={filters.ageGroup} onChange={(value) => updateFilter('ageGroup', value)}>
                  <option value="UNDER_18">Under 18</option>
                  <option value="AGE_18_OR_ABOVE">18 or above</option>
                </FilterSelect>
                <FilterSelect label="Device" value={filters.device} onChange={(value) => updateFilter('device', value)}>
                  <option value="PC">PC</option><option value="Mobile">Mobile</option>
                </FilterSelect>
                <FilterSelect label="AI recommendation" value={filters.recommendation} onChange={(value) => updateFilter('recommendation', value)}>
                  {['RECOMMENDED', 'MANUAL_REVIEW', 'NOT_RECOMMENDED'].map((value) => <option key={value} value={value}>{readable(value)}</option>)}
                </FilterSelect>
                <FilterSelect label="Final decision" value={filters.decision} onChange={(value) => updateFilter('decision', value)}>
                  {['PENDING', 'APPROVED', 'REJECTED'].map((value) => <option key={value} value={value}>{readable(value)}</option>)}
                </FilterSelect>
                <FilterSelect label="Recruitment source" value={filters.recruitmentSource} onChange={(value) => updateFilter('recruitmentSource', value)}>
                  {['Facebook', 'TikTok', 'Discord', 'Others'].map((value) => <option key={value} value={value}>{value}</option>)}
                </FilterSelect>
                <FilterSelect label="Discord onboarding" value={filters.onboardingStatus} onChange={(value) => updateFilter('onboardingStatus', value)}>
                  {['NOT_STARTED', 'PROCESSING', 'COMPLETED', 'FAILED'].map((value) => <option key={value} value={value}>{readable(value)}</option>)}
                </FilterSelect>
              </div>
              <div className="mt-5 flex flex-wrap items-center gap-3">
                <button type="button" onClick={() => setFilters(emptyFilters)} className="h-9 rounded-full border border-bone/15 px-4 text-[0.55rem] font-bold uppercase tracking-[0.1em] text-bone/50">Clear filters</button>
                <button type="button" onClick={toggleVisibleRows} disabled={filteredApplications.length === 0} className="h-9 rounded-full border border-bone/15 px-4 text-[0.55rem] font-bold uppercase tracking-[0.1em] text-bone/50 disabled:opacity-35">Select visible</button>
                <span className="text-xs text-bone/35">{filteredApplications.length} matching applications</span>
              </div>
            </details>
          </section>

          <div className="mb-5 flex items-center justify-between gap-4">
            <p className="ln-label text-bone/40">{filteredApplications.length} of {applications.length} applications</p>
            <button type="button" onClick={() => void Promise.all([loadApplications(), loadExcelStatus(), loadSecurity()])} className="inline-flex h-10 items-center gap-2 rounded-full border border-bone/15 px-4 text-[0.6rem] font-bold uppercase tracking-[0.12em] text-bone/55 transition-colors hover:border-bone/40 hover:text-bone">
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </button>
          </div>

          {applications.length === 0 ? (
            <div className="rounded-[2rem] border border-bone/10 bg-black/30 p-10 text-center text-sm text-bone/45">There are no applications yet.</div>
          ) : (
            <div className="grid min-w-0 gap-5 lg:grid-cols-[22rem_minmax(0,1fr)]">
              <div className="max-h-[48rem] space-y-2 overflow-y-auto pr-1">
                {filteredApplications.length === 0 && (
                  <div className="rounded-2xl border border-bone/10 bg-black/30 p-5 text-sm text-bone/40">No applications match the selected filters.</div>
                )}
                {filteredApplications.map((application) => {
                  const active = application.id === selectedId
                  return (
                    <div key={application.id} className={`flex overflow-hidden rounded-2xl border text-bone shadow-[0_18px_50px_rgba(0,0,0,0.2)] backdrop-blur-xl transition-all ${active ? 'border-white/25 bg-white/[0.1]' : 'border-white/10 bg-white/[0.035] hover:border-white/20 hover:bg-white/[0.055]'}`}>
                      <label className="flex w-11 shrink-0 cursor-pointer items-start justify-center border-r border-current/10 pt-4" title="Select for Excel export">
                        <input
                          type="checkbox"
                          checked={selectedRows.includes(application.id)}
                          onChange={() => toggleSelectedRow(application.id)}
                          className="h-4 w-4 accent-emerald-400"
                          aria-label={`Select ${application.application_number} for Excel export`}
                        />
                      </label>
                      <button type="button" onClick={() => setSelectedId(application.id)} className="min-w-0 flex-1 p-4 text-left">
                        <span className="ln-label text-[0.48rem] opacity-60">{application.application_number}</span>
                        <strong className="mt-2 block truncate font-display text-xl uppercase">{application.in_game_name}</strong>
                        <span className="mt-2 block text-xs opacity-55">{readable(application.status)}</span>
                        <span className="mt-1 block text-[0.62rem] uppercase tracking-[0.08em] opacity-40">AI: {readable(application.ai_evaluation_status)}</span>
                      </button>
                    </div>
                  )
                })}
              </div>

              {selected && (
                <article className="overflow-hidden rounded-[2rem] border border-white/10 bg-white/[0.03] shadow-[0_30px_100px_rgba(0,0,0,0.34)] backdrop-blur-2xl">
                  <header className="flex flex-col gap-5 border-b border-bone/10 p-6 sm:flex-row sm:items-start sm:justify-between sm:p-8">
                    <div>
                      <p className="ln-label text-bone/40">{selected.application_number}</p>
                      <h2 className="mt-2 font-display text-4xl uppercase text-bone">{selected.in_game_name}</h2>
                      <p className="mt-2 text-sm text-bone/40">Discord: {selected.discord_username}</p>
                    </div>
                    <span className="w-fit rounded-full border border-bone/15 px-4 py-2 text-[0.58rem] font-bold uppercase tracking-[0.12em] text-bone/55">{readable(selected.status)}</span>
                  </header>

                  <div className="p-6 sm:p-8">
                    <dl className="grid gap-x-8 md:grid-cols-2">
                      <Detail label="Profile">{readable(selected.age_group)} / {selected.sex} / {selected.device}</Detail>
                      <Detail label="Games">{selected.games.join(', ')}</Detail>
                      <Detail label="Activity">{selected.play_frequency}</Detail>
                      <Detail label="Clan tag">{selected.willing_to_use_clan_tag ? 'Willing' : 'Not willing'}</Detail>
                      <Detail label="Previous clan">{selected.previous_clan}</Detail>
                      <Detail label="Discord answer">{selected.already_joined_discord ? 'Already joined' : 'Not joined'}</Detail>
                      <Detail label="Discord verified">{selected.discord_membership_verified === null ? 'Verification unavailable' : selected.discord_membership_verified ? 'Member found' : 'Not a member yet'}</Detail>
                      <Detail label="Discovery source">{selected.discovery_source === 'Others' ? selected.discovery_source_other || 'Other' : selected.discovery_source}</Detail>
                      <Detail label="Facebook"><a className="text-bone/70 underline-offset-4 hover:text-bone hover:underline" href={selected.facebook_profile_url} target="_blank" rel="noreferrer">Open profile</a></Detail>
                    </dl>

                    <div className="mt-6 space-y-4">
                      <div className="rounded-2xl border border-white/10 bg-white/[0.025] p-5 backdrop-blur-xl">
                        <p className="ln-label text-[0.52rem] text-bone/35">Reason for leaving</p>
                        <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-bone/65">{selected.previous_clan_leaving_reason}</p>
                      </div>
                      <div className="rounded-2xl border border-white/10 bg-white/[0.025] p-5 backdrop-blur-xl">
                        <p className="ln-label text-[0.52rem] text-bone/40">Reason for joining</p>
                        <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-bone/70">{selected.reason_for_joining}</p>
                      </div>
                    </div>

                    {selected.decision_reason && <p className="mt-5 rounded-2xl border border-white/10 bg-white/[0.025] p-4 text-sm text-bone/65 backdrop-blur-xl">Decision: {selected.decision_reason}</p>}

                    <div className="mt-6 rounded-2xl border border-white/10 bg-white/[0.035] p-5 shadow-[0_20px_60px_rgba(0,0,0,0.24)] backdrop-blur-2xl sm:p-6">
                      <div className="flex flex-wrap items-start justify-between gap-4">
                        <div>
                          <p className="flex items-center gap-2 ln-label text-[0.52rem] text-bone/40"><Sparkles className="h-3.5 w-3.5" /> AI recommendation</p>
                          <p className="mt-2 text-xs leading-relaxed text-bone/40">Advisory only. A NightRaid administrator makes the final decision.</p>
                        </div>
                        <span className="rounded-full border border-bone/15 px-3 py-1.5 text-[0.55rem] font-bold uppercase tracking-[0.1em] text-bone/55">{readable(selected.ai_evaluation_status)}</span>
                      </div>

                      {selected.ai_evaluation_status === 'COMPLETED' && selected.ai_evaluation ? (
                        <div className="mt-6">
                          <div className="grid gap-3 sm:grid-cols-3">
                            <div className="rounded-xl border border-bone/10 bg-black/25 p-4">
                              <p className="ln-label text-[0.48rem] text-bone/35">Score</p>
                              <strong className="mt-2 block font-display text-3xl text-bone">{selected.ai_evaluation.score}<span className="text-base text-bone/30">/100</span></strong>
                            </div>
                            <div className="rounded-xl border border-bone/10 bg-black/25 p-4">
                              <p className="ln-label text-[0.48rem] text-bone/35">Recommendation</p>
                              <strong className="mt-2 block text-sm uppercase tracking-[0.08em] text-bone">{readable(selected.ai_evaluation.recommendation)}</strong>
                            </div>
                            <div className="rounded-xl border border-bone/10 bg-black/25 p-4">
                              <p className="ln-label text-[0.48rem] text-bone/35">Confidence</p>
                              <strong className="mt-2 block font-display text-3xl text-bone">{Math.round(selected.ai_evaluation.confidence * 100)}%</strong>
                            </div>
                          </div>

                          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                            {[
                              ['Motivation', selected.ai_evaluation.motivation_score, 25],
                              ['Teamwork', selected.ai_evaluation.teamwork_score, 20],
                              ['Activity', selected.ai_evaluation.activity_score, 15],
                              ['Clan commitment', selected.ai_evaluation.clan_commitment_score, 20],
                              ['Consistency', selected.ai_evaluation.consistency_score, 10],
                              ['Communication', selected.ai_evaluation.communication_score, 10],
                            ].map(([label, score, maximum]) => (
                              <div key={String(label)} className="flex items-center justify-between rounded-xl border border-bone/10 bg-black/20 px-4 py-3 text-xs">
                                <span className="text-bone/45">{label}</span>
                                <strong className="text-bone">{score}/{maximum}</strong>
                              </div>
                            ))}
                          </div>

                          <p className="mt-5 text-sm leading-relaxed text-bone/65">{selected.ai_evaluation.summary}</p>
                          <div className="mt-5 grid gap-4 md:grid-cols-2">
                            <div className="rounded-xl border border-white/10 bg-white/[0.025] p-4 backdrop-blur-xl">
                              <p className="ln-label text-[0.48rem] text-bone/40">Strengths</p>
                              {selected.ai_evaluation.strengths.length > 0 ? (
                                <ul className="mt-3 space-y-2 text-xs leading-relaxed text-bone/60">{selected.ai_evaluation.strengths.map((strength) => <li key={strength}>+ {strength}</li>)}</ul>
                              ) : <p className="mt-3 text-xs text-bone/35">No clear strengths identified.</p>}
                            </div>
                            <div className="rounded-xl border border-white/10 bg-white/[0.025] p-4 backdrop-blur-xl">
                              <p className="ln-label text-[0.48rem] text-bone/40">Concerns</p>
                              {selected.ai_evaluation.concerns.length > 0 ? (
                                <ul className="mt-3 space-y-2 text-xs leading-relaxed text-bone/60">{selected.ai_evaluation.concerns.map((concern) => <li key={concern}>- {concern}</li>)}</ul>
                              ) : <p className="mt-3 text-xs text-bone/35">No specific concerns identified.</p>}
                            </div>
                          </div>
                          <p className="mt-4 text-[0.62rem] text-bone/25">{selected.ai_evaluation.model} · {selected.ai_evaluation.prompt_version} · {new Date(selected.ai_evaluation.created_at).toLocaleString()}</p>
                        </div>
                      ) : selected.ai_evaluation_status === 'FAILED' ? (
                        <div className="mt-5 rounded-xl border border-white/10 bg-black/20 p-4">
                          <p className="text-sm text-bone/65">The automated review failed safely. The application is still ready for human review.</p>
                          {selected.ai_evaluation_error && <p className="mt-2 break-words text-xs text-bone/35">{selected.ai_evaluation_error}</p>}
                        </div>
                      ) : (
                        <p className="mt-5 text-sm text-bone/45">{selected.ai_evaluation_status === 'PROCESSING' ? 'The AI model is reviewing this application.' : 'No automated review has run yet.'}</p>
                      )}

                      {selected.status === 'PENDING_REVIEW' && selected.ai_evaluation_status !== 'PROCESSING' && (
                        <button type="button" disabled={acting} onClick={() => void retryEvaluation()} className="mt-5 inline-flex h-10 items-center gap-2 rounded-full border border-blood/40 px-5 text-[0.6rem] font-extrabold uppercase tracking-[0.12em] text-blood transition-colors hover:bg-blood hover:text-bone disabled:opacity-50">
                          <RefreshCw className="h-3.5 w-3.5" /> {selected.ai_evaluation_status === 'COMPLETED' ? 'Re-run AI review' : 'Retry AI review'}
                        </button>
                      )}
                    </div>

                    <div className="mt-6 rounded-2xl border border-white/10 bg-white/[0.035] p-5 shadow-[0_20px_60px_rgba(0,0,0,0.24)] backdrop-blur-2xl">
                      <p className="ln-label text-[0.52rem] text-bone/40">Discord onboarding</p>
                      <p className="mt-3 text-sm font-bold uppercase tracking-[0.08em] text-bone">{readable(selected.discord_onboarding_status)}</p>
                      {selected.assigned_discord_roles.length > 0 && (
                        <p className="mt-2 text-sm text-bone/55">Roles: {selected.assigned_discord_roles.join(', ')}</p>
                      )}
                      {selected.discord_onboarded_at && (
                        <p className="mt-2 text-xs text-bone/35">Completed {new Date(selected.discord_onboarded_at).toLocaleString()}</p>
                      )}
                      {selected.discord_onboarding_error && (
                        <p className="mt-3 rounded-xl border border-white/10 bg-black/20 p-3 text-xs leading-relaxed text-bone/55">{selected.discord_onboarding_error}</p>
                      )}
                    </div>

                    <div className="mt-6 rounded-2xl border border-white/10 bg-white/[0.035] p-5 shadow-[0_20px_60px_rgba(0,0,0,0.24)] backdrop-blur-2xl">
                      <div className="flex flex-wrap items-start justify-between gap-4">
                        <div>
                          <p className="flex items-center gap-2 ln-label text-[0.52rem] text-bone/40"><MessageCircle className="h-3.5 w-3.5" /> Messenger notification</p>
                          <p className="mt-3 text-sm font-bold uppercase tracking-[0.08em] text-bone">{readable(selected.messenger_notification_status)}</p>
                        </div>
                        {selected.messenger_message_ids.length > 0 && (
                          <span className="rounded-full border border-white/10 px-3 py-1.5 text-[0.55rem] font-bold uppercase tracking-[0.1em] text-bone/45">{selected.messenger_message_ids.length} messages</span>
                        )}
                      </div>
                      {selected.messenger_notified_at && (
                        <p className="mt-2 text-xs text-bone/35">Delivered {new Date(selected.messenger_notified_at).toLocaleString()}</p>
                      )}
                      {selected.messenger_notification_error && (
                        <p className="mt-3 break-words rounded-xl border border-white/10 bg-black/20 p-3 text-xs leading-relaxed text-bone/55">{selected.messenger_notification_error}</p>
                      )}
                      {selected.status === 'PENDING_REVIEW' && ['NOT_STARTED', 'FAILED'].includes(selected.messenger_notification_status) && (
                        <button type="button" disabled={acting} onClick={() => void retryMessenger()} className="mt-4 inline-flex h-10 items-center gap-2 rounded-full border border-sky-300/30 px-5 text-[0.6rem] font-extrabold uppercase tracking-[0.12em] text-sky-200 transition-colors hover:bg-sky-300 hover:text-black disabled:opacity-50">
                          <RefreshCw className="h-3.5 w-3.5" /> Retry Messenger
                        </button>
                      )}
                    </div>

                    <div className="mt-6 rounded-2xl border border-white/10 bg-white/[0.035] p-5 shadow-[0_20px_60px_rgba(0,0,0,0.24)] backdrop-blur-2xl">
                      <div className="flex flex-wrap items-start justify-between gap-4">
                        <div>
                          <p className="flex items-center gap-2 ln-label text-[0.52rem] text-bone/40"><FileSpreadsheet className="h-3.5 w-3.5" /> Excel synchronization</p>
                          <p className="mt-3 text-sm font-bold uppercase tracking-[0.08em] text-bone">{readable(selected.excel_sync_status)}</p>
                        </div>
                        {selected.excel_synced_at && (
                          <span className="text-xs text-bone/35">Updated {new Date(selected.excel_synced_at).toLocaleString()}</span>
                        )}
                      </div>
                      {selected.excel_sync_error && (
                        <p className="mt-3 break-words rounded-xl border border-white/10 bg-black/20 p-3 text-xs leading-relaxed text-bone/55">{selected.excel_sync_error}</p>
                      )}
                      {['NOT_STARTED', 'FAILED'].includes(selected.excel_sync_status) && (
                        <button type="button" disabled={excelBusy} onClick={() => void syncExcel([selected.id])} className="mt-4 inline-flex h-10 items-center gap-2 rounded-full border border-emerald-300/30 px-5 text-[0.6rem] font-extrabold uppercase tracking-[0.12em] text-emerald-200 transition-colors hover:bg-emerald-300 hover:text-black disabled:opacity-50">
                          <RefreshCw className={`h-3.5 w-3.5 ${excelBusy ? 'animate-spin' : ''}`} /> Retry Excel sync
                        </button>
                      )}
                    </div>

                    {['SUBMITTED', 'PENDING_REVIEW'].includes(selected.status) && (
                      <div className="mt-7 flex flex-wrap gap-3 border-t border-bone/10 pt-7">
                        <button type="button" disabled={acting} onClick={() => void decide('approve')} className="inline-flex h-11 items-center gap-2 rounded-full bg-emerald-500 px-6 text-[0.65rem] font-extrabold uppercase tracking-[0.12em] text-black disabled:opacity-50">
                          <Check className="h-4 w-4" /> Approve
                        </button>
                        <button type="button" disabled={acting} onClick={() => void decide('reject')} className="inline-flex h-11 items-center gap-2 rounded-full border border-red-400/35 px-6 text-[0.65rem] font-extrabold uppercase tracking-[0.12em] text-red-300 disabled:opacity-50">
                          <X className="h-4 w-4" /> Reject
                        </button>
                      </div>
                    )}

                    {['APPROVED', 'DISCORD_JOIN_FAILED'].includes(selected.status) && selected.discord_onboarding_status !== 'PROCESSING' && (
                      <div className="mt-7 border-t border-bone/10 pt-7">
                        <button type="button" disabled={acting} onClick={() => void retryDiscord()} className="inline-flex h-11 items-center gap-2 rounded-full bg-[#5865F2] px-6 text-[0.65rem] font-extrabold uppercase tracking-[0.12em] text-white disabled:opacity-50">
                          <RefreshCw className="h-4 w-4" /> Retry Discord
                        </button>
                      </div>
                    )}
                  </div>
                </article>
              )}
            </div>
          )}
        </>
      )}
    </PortalShell>
  )
}
