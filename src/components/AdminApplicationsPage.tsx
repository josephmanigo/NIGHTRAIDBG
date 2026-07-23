import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, Ban, Check, History, LogOut, MessageCircle, RefreshCw, ShieldAlert, UserRoundX, X } from 'lucide-react'
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
  messenger_notification_status: string
  messenger_notification_error: string | null
  messenger_notified_at: string | null
  messenger_message_ids: string[]
  submitted_at: string
  reviewed_at: string | null
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

function readable(value: string) {
  return value.split('_').join(' ')
}

function requestError(reason: unknown, fallback: string) {
  const message = reason instanceof Error ? reason.message : ''
  return message === 'Failed to fetch'
    ? 'The NightRaid server connection was interrupted. Please try again.'
    : message || fallback
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-bone/10 py-4 last:border-b-0">
      <dt className="ln-label text-[0.52rem] text-bone/35">{label}</dt>
      <dd className="mt-2 text-sm leading-relaxed text-bone/70">{children}</dd>
    </div>
  )
}

export default function AdminApplicationsPage() {
  const [session, setSession] = useState<AdminSession | null>(null)
  const [applications, setApplications] = useState<AdminApplication[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [securityData, setSecurityData] = useState<SecurityData | null>(null)
  const [securityBusy, setSecurityBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
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

  const loadSecurity = useCallback(async () => {
    try {
      const response = await fetch('/api/admin/security', { credentials: 'same-origin' })
      if (!response.ok || !(response.headers.get('content-type') || '').includes('application/json')) {
        setSecurityData(null)
        return
      }
      setSecurityData(await response.json() as SecurityData)
    } catch {
      setSecurityData(null)
    }
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
          await Promise.all([loadApplications(), loadSecurity()])
        }
      } catch (reason) {
        if (!cancelled) setError(requestError(reason, 'Unable to load the administrator portal.'))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [loadApplications, loadSecurity])

  useEffect(() => {
    if (!loading && session && (!session.connected || !session.isAdmin)) {
      window.location.replace('/admin/login')
    }
  }, [loading, session])

  const selected = useMemo(
    () => applications.find((application) => application.id === selectedId) ?? null,
    [applications, selectedId],
  )

  const logout = async () => {
    if (acting) return
    setActing(true)
    setError('')

    try {
      const response = await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
      })
      if (!response.ok) throw new Error('Unable to log out of Application Command.')
      window.location.replace('/')
    } catch (reasonValue) {
      setError(requestError(reasonValue, 'Unable to log out of Application Command.'))
      setActing(false)
    }
  }

  const refreshData = async () => {
    if (refreshing) return
    setRefreshing(true)
    setError('')

    try {
      await Promise.all([loadApplications(), loadSecurity()])
    } catch (reasonValue) {
      setError(requestError(reasonValue, 'Unable to refresh Application Command.'))
    } finally {
      setRefreshing(false)
    }
  }

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
      setError(requestError(reasonValue, 'The decision could not be saved.'))
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
      setError(requestError(reasonValue, 'Discord onboarding could not be retried.'))
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
      setError(requestError(reasonValue, 'Messenger notification could not be retried.'))
    } finally {
      setActing(false)
    }
  }

  const removeMember = async () => {
    if (!selected || acting) return
    const answer = window.prompt(`Why is ${selected.in_game_name} being removed from NightRaid?`)
    if (answer === null) return
    const reason = answer.trim()
    if (reason.length < 2) {
      setError('Enter a clear removal reason before continuing.')
      return
    }
    const kickFromDiscord = window.confirm(
      'Also kick them from the NightRaid Discord server?\n\nOK = remove membership and kick from Discord.\nCancel = remove membership and clear game roles, but keep them in the server.',
    )
    if (!window.confirm(`Remove ${selected.in_game_name} from NightRaid now?`)) return

    setActing(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch(`/api/admin/applications/${selected.id}/remove`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason, kickFromDiscord }),
      })
      if (!(response.headers.get('content-type') || '').includes('application/json')) {
        throw new Error('The server API returned an invalid response.')
      }
      const payload = (await response.json()) as { message?: string; discordCleanup?: string }
      await loadApplications()
      if (!response.ok) throw new Error(payload.message || 'Unable to remove this member.')
      if (payload.discordCleanup === 'FAILED') {
        setError(payload.message || 'The member was removed, but the Discord cleanup failed.')
      } else {
        setNotice(payload.message || 'The member was removed from NightRaid.')
      }
    } catch (reasonValue) {
      setError(requestError(reasonValue, 'Unable to remove this member.'))
    } finally {
      setActing(false)
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
      setError(requestError(reasonValue, 'Unable to activate the applicant ban.'))
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
      setError(requestError(reasonValue, 'Unable to deactivate the ban.'))
    } finally {
      setSecurityBusy(false)
    }
  }

  return (
    <PortalShell
      title="Application"
      accent="command"
      kicker="Review complete applications and record the final NightRaid administrator decision."
      showHeaderDivider={false}
      headerAction={(
        <button
          type="button"
          disabled={acting}
          onClick={() => void logout()}
          className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-[0.12em] text-bone/55 transition-colors hover:text-blood disabled:cursor-wait disabled:opacity-40"
        >
          <LogOut className="h-4 w-4" /> Logout
        </button>
      )}
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

          <section className="mb-5 rounded-[2rem] border border-white/10 bg-white/[0.035] p-5 backdrop-blur-2xl sm:p-7">
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

          <div className="mb-5 flex items-center justify-between gap-4">
            <p className="ln-label text-bone/40">{applications.length} applications</p>
            <button type="button" disabled={refreshing} onClick={() => void refreshData()} className="inline-flex h-10 items-center gap-2 rounded-full border border-bone/15 px-4 text-[0.6rem] font-bold uppercase tracking-[0.12em] text-bone/55 transition-colors hover:border-bone/40 hover:text-bone disabled:cursor-wait disabled:opacity-40">
              <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} /> Refresh
            </button>
          </div>

          {applications.length === 0 ? (
            <div className="rounded-[2rem] border border-bone/10 bg-black/30 p-10 text-center text-sm text-bone/45">There are no applications yet.</div>
          ) : (
            <div className="grid min-w-0 gap-5 lg:grid-cols-[22rem_minmax(0,1fr)]">
              <div className="max-h-[48rem] space-y-2 overflow-y-auto pr-1">
                {applications.map((application) => {
                  const active = application.id === selectedId
                  return (
                    <div key={application.id} className={`flex overflow-hidden rounded-2xl border text-bone backdrop-blur-xl transition-all ${active ? 'border-white/25 bg-white/[0.1]' : 'border-white/10 bg-white/[0.035] hover:border-white/20 hover:bg-white/[0.055]'}`}>
                      <button type="button" onClick={() => setSelectedId(application.id)} className="min-w-0 flex-1 p-4 text-left">
                        <span className="ln-label text-[0.48rem] opacity-60">{application.application_number}</span>
                        <strong className="mt-2 block truncate font-display text-xl uppercase">{application.in_game_name}</strong>
                        <span className="mt-2 block text-xs opacity-55">{readable(application.status)}</span>
                      </button>
                    </div>
                  )
                })}
              </div>

              {selected && (
                <article className="overflow-hidden rounded-[2rem] border border-white/10 bg-white/[0.03] backdrop-blur-2xl">
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

                    <div className="mt-6 rounded-2xl border border-white/10 bg-white/[0.035] p-5 backdrop-blur-2xl">
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

                    <div className="mt-6 rounded-2xl border border-white/10 bg-white/[0.035] p-5 backdrop-blur-2xl">
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

                    {['APPROVED', 'DISCORD_JOIN_FAILED', 'COMPLETED'].includes(selected.status) && (
                      <div className="mt-7 flex flex-wrap gap-3 border-t border-bone/10 pt-7">
                        {['APPROVED', 'DISCORD_JOIN_FAILED'].includes(selected.status) && selected.discord_onboarding_status !== 'PROCESSING' && (
                          <button type="button" disabled={acting} onClick={() => void retryDiscord()} className="inline-flex h-11 items-center gap-2 rounded-full bg-[#5865F2] px-6 text-[0.65rem] font-extrabold uppercase tracking-[0.12em] text-white disabled:opacity-50">
                            <RefreshCw className="h-4 w-4" /> Retry Discord
                          </button>
                        )}
                        <button type="button" disabled={acting} onClick={() => void removeMember()} className="inline-flex h-11 items-center gap-2 rounded-full border border-red-400/35 px-6 text-[0.65rem] font-extrabold uppercase tracking-[0.12em] text-red-300 transition-colors hover:bg-red-400/10 disabled:opacity-50">
                          <UserRoundX className="h-4 w-4" /> Remove member
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
