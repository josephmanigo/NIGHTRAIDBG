import { useEffect, useState } from 'react'
import { AlertCircle, Check, Clock3, DoorOpen, Gamepad2, ShieldCheck, Sparkles } from 'lucide-react'
import PortalShell from './PortalShell'

interface ApplicantSession {
  connected: boolean
  discordUsername?: string
}

interface ApplicantApplication {
  application_number: string
  in_game_name: string
  games: string[]
  status: string
  decision_reason: string | null
  discord_membership_verified: boolean | null
  discord_onboarding_status: string
  assigned_discord_roles: string[]
  discord_onboarded_at: string | null
  ai_evaluation_status: string
  ai_evaluated_at: string | null
  submitted_at: string
  reviewed_at: string | null
}

const FLOW = ['SUBMITTED', 'PENDING_REVIEW', 'APPROVED', 'COMPLETED'] as const
const MEMBER_STATUSES = ['APPROVED', 'DISCORD_JOIN_FAILED', 'COMPLETED']
const EXIT_STATUSES = ['REMOVED', 'LEFT']
const MESSENGER_GROUP_CHAT_URL = 'https://m.me/ch/AbaeMdWdMHYbxpIE/'
const DISCORD_NICKNAME_SERVER_URL = 'https://discord.gg/Ay8uSSJS3N'
const MESSENGER_GAME_TAGS: Record<string, string> = {
  Bloodstrike: 'BS',
  'Mobile Legends': 'ML',
  Farlight: 'FL',
}

function statusLabel(status: string) {
  return status.split('_').join(' ')
}

function statusIndex(status: string) {
  if (status === 'PROCESSING') return 0
  if (status === 'REJECTED') return 2
  if (status === 'DISCORD_JOIN_FAILED') return 2
  return Math.max(0, FLOW.indexOf(status as (typeof FLOW)[number]))
}

export default function ApplicationStatusPage() {
  const [session, setSession] = useState<ApplicantSession | null>(null)
  const [application, setApplication] = useState<ApplicantApplication | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [leaving, setLeaving] = useState(false)
  const [leaveError, setLeaveError] = useState('')

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const sessionResponse = await fetch('/api/auth/session', { credentials: 'same-origin' })
        if (!sessionResponse.ok) throw new Error('Unable to check your Discord session.')
        if (!(sessionResponse.headers.get('content-type') || '').includes('application/json')) {
          throw new Error('The server API is not running. Start the site with npm run dev:full.')
        }
        const nextSession = (await sessionResponse.json()) as ApplicantSession
        if (cancelled) return
        setSession(nextSession)
        if (!nextSession.connected) return

        const applicationResponse = await fetch('/api/clan-applications/me', { credentials: 'same-origin' })
        if (!(applicationResponse.headers.get('content-type') || '').includes('application/json')) {
          throw new Error('The server API returned an invalid response.')
        }
        const payload = (await applicationResponse.json()) as { application?: ApplicantApplication | null; message?: string }
        if (!applicationResponse.ok) throw new Error(payload.message || 'Unable to load your application.')
        if (!cancelled) setApplication(payload.application ?? null)
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : 'Unable to load your status.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [])

  const leaveClan = async () => {
    if (!application || leaving) return
    if (!window.confirm('Leave NIGHTRAID?\n\nYour membership will be closed and your NIGHTRAID game roles on Discord will be cleared. You can apply again later.')) {
      return
    }
    setLeaving(true)
    setLeaveError('')
    try {
      const response = await fetch('/api/clan-applications/leave', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      if (!(response.headers.get('content-type') || '').includes('application/json')) {
        throw new Error('The server API returned an invalid response.')
      }
      const payload = (await response.json()) as { message?: string }
      if (!response.ok) throw new Error(payload.message || 'Unable to leave the clan right now.')
      setApplication((current) => (current ? { ...current, status: 'LEFT', assigned_discord_roles: [] } : current))
    } catch (reason) {
      setLeaveError(reason instanceof Error ? reason.message : 'Unable to leave the clan right now.')
    } finally {
      setLeaving(false)
    }
  }

  const activeIndex = application ? statusIndex(application.status) : 0
  const messengerTags = application
    ? application.games.map((game) => MESSENGER_GAME_TAGS[game]).filter(Boolean)
    : []
  const messengerNickname =
    application && messengerTags.length > 0 ? `${application.in_game_name} (${messengerTags.join(', ')})` : ''

  return (
    <PortalShell
      title="Track your"
      accent="raid"
      kicker="Follow your application from submission through administrator review and Discord onboarding."
      showHeaderDivider={false}
    >
      {loading ? (
        <div className="rounded-[2rem] border border-bone/10 bg-black/30 p-10 text-center text-sm text-bone/45">Loading your application...</div>
      ) : error ? (
        <div className="flex items-start gap-3 rounded-2xl border border-red-400/25 bg-red-400/5 p-5 text-sm text-red-200">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
        </div>
      ) : !session?.connected ? (
        <div className="rounded-[2rem] border border-[#5865F2]/30 bg-[#5865F2]/10 p-7 sm:p-10">
          <h2 className="font-display text-3xl uppercase text-bone">Connect Discord first</h2>
          <p className="mt-3 max-w-xl text-sm leading-relaxed text-bone/50">Use the same Discord account used for your application. Your status is never exposed through a public application ID.</p>
          <a href="/api/auth/discord?returnTo=%2Fapplication%2Fstatus" className="mt-7 inline-flex h-11 items-center rounded-full bg-[#5865F2] px-6 text-[0.65rem] font-extrabold uppercase tracking-[0.12em] text-white">Continue with Discord</a>
        </div>
      ) : !application ? (
        <div className="rounded-[2rem] border border-bone/10 bg-black/30 p-7 sm:p-10">
          <h2 className="font-display text-3xl uppercase text-bone">No application found</h2>
          <p className="mt-3 text-sm text-bone/50">No NIGHTRAID application is connected to {session.discordUsername}.</p>
          <a href="/apply" className="ln-pill mt-7">Start an application</a>
        </div>
      ) : (
        <div className="overflow-hidden rounded-[2rem] border border-bone/15 bg-[#080808]/90">
          <div className="grid gap-6 border-b border-bone/10 p-6 sm:grid-cols-[1fr_auto] sm:items-center sm:p-9">
            <div>
              <p className="ln-label text-bone/35">Application ID</p>
              <h2 className="mt-2 font-display text-3xl uppercase text-bone sm:text-5xl">{application.application_number}</h2>
              <p className="mt-3 text-sm text-bone/45">Submitted {new Date(application.submitted_at).toLocaleString()}</p>
            </div>
            <span className={`w-fit rounded-full border px-4 py-2 text-[0.62rem] font-extrabold uppercase tracking-[0.12em] ${['REJECTED', 'REMOVED'].includes(application.status) ? 'border-red-400/30 bg-red-400/10 text-red-300' : application.status === 'APPROVED' || application.status === 'COMPLETED' ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300' : application.status === 'LEFT' ? 'border-bone/20 bg-bone/5 text-bone/55' : 'border-amber-300/30 bg-amber-300/10 text-amber-200'}`}>
              {statusLabel(application.status)}
            </span>
          </div>

          <div className="p-6 sm:p-9">
            {!EXIT_STATUSES.includes(application.status) && (
              <div className="grid gap-px overflow-hidden rounded-2xl border border-bone/10 bg-bone/10 sm:grid-cols-4">
                {FLOW.map((status, index) => {
                  const complete = index < activeIndex || application.status === 'COMPLETED'
                  const active = index === activeIndex
                  return (
                    <div key={status} className="bg-[#0a0a0a] p-5">
                      <span className={`flex h-9 w-9 items-center justify-center rounded-full border ${complete ? 'border-emerald-400 bg-emerald-400 text-black' : active ? 'border-blood bg-blood text-bone' : 'border-bone/15 text-bone/30'}`}>
                        {complete ? <Check className="h-4 w-4" /> : active ? <Clock3 className="h-4 w-4" /> : <span className="text-xs font-bold">0{index + 1}</span>}
                      </span>
                      <strong className="mt-4 block font-display text-lg uppercase text-bone">{statusLabel(status)}</strong>
                    </div>
                  )
                })}
              </div>
            )}

            {application.status === 'LEFT' && (
              <div className="rounded-2xl border border-bone/15 bg-bone/[0.03] p-5 sm:p-7">
                <span className="flex h-9 w-9 items-center justify-center rounded-full border border-bone/20 text-bone/55">
                  <DoorOpen className="h-4 w-4" />
                </span>
                <strong className="mt-4 block font-display text-2xl uppercase text-bone">Membership closed</strong>
                <p className="mt-3 max-w-xl text-sm leading-relaxed text-bone/50">
                  You left NIGHTRAID, <strong className="text-bone">{application.in_game_name}</strong>. Your game roles were cleared and this application is now archived. The door stays open whenever you want back in.
                </p>
                <a href="/apply" className="ln-pill mt-6">Apply again</a>
              </div>
            )}

            {application.status === 'REMOVED' && (
              <div className="rounded-2xl border border-red-400/25 bg-red-400/[0.07] p-5 sm:p-7">
                <span className="flex h-9 w-9 items-center justify-center rounded-full border border-red-400/30 text-red-300">
                  <AlertCircle className="h-4 w-4" />
                </span>
                <strong className="mt-4 block font-display text-2xl uppercase text-bone">Membership ended</strong>
                <p className="mt-3 max-w-xl text-sm leading-relaxed text-red-50/70">
                  An administrator has removed you from the NIGHTRAID roster. The recorded reason appears below. Unless a ban is active, you may submit a new application in the future.
                </p>
              </div>
            )}

            <div className="mt-7 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-2xl border border-bone/10 bg-bone/[0.025] p-5">
                <span className="flex items-center gap-2 text-bone/35"><ShieldCheck className="h-4 w-4" /><span className="ln-label text-[0.52rem]">Player</span></span>
                <strong className="mt-3 block text-bone">{application.in_game_name}</strong>
              </div>
              <div className="rounded-2xl border border-bone/10 bg-bone/[0.025] p-5">
                <span className="flex items-center gap-2 text-bone/35"><Gamepad2 className="h-4 w-4" /><span className="ln-label text-[0.52rem]">Divisions</span></span>
                <strong className="mt-3 block text-bone">{application.games.join(', ')}</strong>
              </div>
              <div className="rounded-2xl border border-bone/10 bg-bone/[0.025] p-5">
                <span className="flex items-center gap-2 text-bone/35"><ShieldCheck className="h-4 w-4" /><span className="ln-label text-[0.52rem]">Discord check</span></span>
                <strong className="mt-3 block text-bone">{application.discord_membership_verified === null ? 'Unavailable' : application.discord_membership_verified ? 'Member verified' : 'Awaiting onboarding'}</strong>
              </div>
              <div className="rounded-2xl border border-bone/10 bg-bone/[0.025] p-5">
                <span className="flex items-center gap-2 text-bone/35"><Sparkles className="h-4 w-4" /><span className="ln-label text-[0.52rem]">Automated check</span></span>
                <strong className="mt-3 block text-bone">{application.ai_evaluation_status === 'FAILED' ? 'Human review ready' : statusLabel(application.ai_evaluation_status)}</strong>
              </div>
            </div>

            {['APPROVED', 'DISCORD_JOIN_FAILED', 'COMPLETED'].includes(application.status) && (
              <div className="relative mt-7 overflow-hidden rounded-[1.75rem] border border-blood/40 bg-[radial-gradient(circle_at_top_right,rgba(220,0,36,0.22),transparent_42%),linear-gradient(135deg,rgba(56,0,10,0.7),rgba(5,5,5,0.96)_58%)] p-5 shadow-[0_25px_80px_rgba(130,0,20,0.18)] sm:p-7">
                <div className="pointer-events-none absolute -right-20 -top-20 h-56 w-56 rounded-full border border-blood/20" />
                <div className="pointer-events-none absolute -right-8 -top-8 h-32 w-32 rounded-full border border-blood/15" />
                <div className="relative">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <p className="ln-label text-[0.55rem] text-blood">NR // Recruitment clearance</p>
                      <h3 className="mt-3 font-display text-3xl uppercase leading-none text-bone sm:text-5xl">Raid access granted</h3>
                    </div>
                    <span className="rounded-full border border-blood/40 bg-blood/10 px-4 py-2 text-[0.55rem] font-extrabold uppercase tracking-[0.14em] text-red-200">Accepted</span>
                  </div>
                  <p className="mt-5 max-w-2xl text-sm leading-relaxed text-bone/60">
                    Welcome to NIGHTRAID, <strong className="text-bone">{application.in_game_name}</strong>.
                    {application.status === 'COMPLETED'
                      ? ' Your Discord onboarding is complete and your selected roles are ready.'
                      : ' Your Discord onboarding is now being completed by an administrator.'}
                  </p>

                  <div className="mt-6 border-t border-blood/20 pt-6">
                    <p className="ln-label text-[0.52rem] text-blood">Required identity setup</p>
                    <div className="mt-4 grid gap-3 md:grid-cols-2">
                      <div className="rounded-2xl border border-bone/10 bg-black/35 p-4 sm:p-5">
                        <p className="ln-label text-[0.48rem] text-bone/35">Messenger group</p>
                        <p className="mt-3 text-xs leading-relaxed text-bone/45">Set your group-chat nickname to</p>
                        <strong className="mt-2 block break-words font-display text-xl uppercase tracking-wide text-bone">
                          {messengerNickname || `${application.in_game_name} + division tag`}
                        </strong>
                      </div>
                      <div className="rounded-2xl border border-blood/20 bg-blood/[0.06] p-4 sm:p-5">
                        <p className="ln-label text-[0.48rem] text-blood">Discord server</p>
                        <p className="mt-3 text-xs leading-relaxed text-bone/45">Set your server nickname to</p>
                        <strong className="mt-2 block break-words font-display text-xl uppercase tracking-wide text-bone">
                          {`NIGHT \u2022 ${application.in_game_name}`}
                        </strong>
                      </div>
                    </div>
                  </div>

                  <div className="mt-5 flex flex-wrap gap-2">
                    <a
                      href={MESSENGER_GROUP_CHAT_URL}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex h-11 items-center rounded-full bg-blood px-5 text-[0.58rem] font-extrabold uppercase tracking-[0.12em] text-bone shadow-[0_10px_30px_rgba(220,0,36,0.25)] transition-colors hover:bg-red-600"
                    >
                      Enter Messenger group
                    </a>
                    <a
                      href={DISCORD_NICKNAME_SERVER_URL}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex h-11 items-center rounded-full border border-bone/20 bg-bone/[0.04] px-5 text-[0.58rem] font-extrabold uppercase tracking-[0.12em] text-bone transition-colors hover:border-bone/50 hover:bg-bone/10"
                    >
                      Open nickname channel
                    </a>
                  </div>
                  <p className="mt-5 text-[0.58rem] font-bold uppercase tracking-[0.16em] text-bone/25">Built in darkness. Proven under pressure.</p>
                </div>
              </div>
            )}

            {application.status === 'REJECTED' && (
              <div className="mt-7 rounded-2xl border border-red-400/25 bg-red-400/[0.07] p-5">
                <p className="ln-label text-[0.55rem] text-red-300">Application decision</p>
                <p className="mt-3 text-sm leading-relaxed text-red-50/75">
                  Thank you for applying to NIGHTRAID. Your application was not accepted at this time.
                </p>
              </div>
            )}

            {application.assigned_discord_roles.length > 0 && (
              <div className="mt-7 rounded-2xl border border-[#5865F2]/20 bg-[#5865F2]/5 p-5">
                <p className="ln-label text-[0.55rem] text-[#9da5ff]">Discord roles assigned</p>
                <p className="mt-3 text-sm leading-relaxed text-bone/70">{application.assigned_discord_roles.join(', ')}</p>
              </div>
            )}

            {application.status === 'DISCORD_JOIN_FAILED' && (
              <div className="mt-7 rounded-2xl border border-amber-300/20 bg-amber-300/5 p-5">
                <p className="ln-label text-[0.55rem] text-amber-200">Onboarding needs attention</p>
                <p className="mt-3 text-sm leading-relaxed text-amber-100/70">Your application is approved, but Discord onboarding needs an administrator retry. You do not need to submit another application.</p>
              </div>
            )}

            {application.decision_reason && (
              <div className="mt-7 rounded-2xl border border-red-400/20 bg-red-400/5 p-5">
                <p className="ln-label text-[0.55rem] text-red-300">Decision note</p>
                <p className="mt-3 text-sm leading-relaxed text-red-100/70">{application.decision_reason}</p>
              </div>
            )}

            {MEMBER_STATUSES.includes(application.status) && (
              <div className="mt-7 rounded-2xl border border-bone/10 bg-bone/[0.02] p-5 sm:p-6">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="ln-label text-[0.55rem] text-bone/40">Membership</p>
                    <p className="mt-2 max-w-xl text-sm leading-relaxed text-bone/50">
                      Leaving closes your membership and clears your NIGHTRAID game roles on Discord. You can apply again later.
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={leaving}
                    onClick={() => void leaveClan()}
                    className="inline-flex h-11 shrink-0 items-center gap-2 rounded-full border border-red-400/35 px-6 text-[0.62rem] font-extrabold uppercase tracking-[0.12em] text-red-300 transition-colors hover:bg-red-400/10 disabled:cursor-wait disabled:opacity-50"
                  >
                    <DoorOpen className="h-4 w-4" /> {leaving ? 'Leaving...' : 'Leave NIGHTRAID'}
                  </button>
                </div>
                {leaveError && (
                  <p className="mt-4 flex items-start gap-2 text-xs leading-relaxed text-red-300" role="alert">
                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {leaveError}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </PortalShell>
  )
}
