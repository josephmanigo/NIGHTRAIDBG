import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity,
  ArrowLeft,
  Bot,
  Check,
  Command,
  ExternalLink,
  Gauge,
  Layers3,
  LogOut,
  Plus,
  Power,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  Video,
  Wifi,
  WifiOff,
} from 'lucide-react'
import PortalShell from './PortalShell'

interface AdminSession {
  connected: boolean
  discordUsername?: string
  isAdmin?: boolean
}

interface BotModule {
  id: string
  name: string
  description: string
}

interface BuiltInCommand {
  name: string
  description: string
  module: string
}

interface DashboardSettings {
  disabledCommands: string[]
  modules: Record<string, boolean>
  presenceText: string
  presenceStatus: 'online' | 'idle' | 'dnd' | 'invisible'
  presenceActivityType: 'PLAYING' | 'WATCHING' | 'LISTENING' | 'COMPETING'
  updatedAt: string | null
}

interface CustomCommand {
  id: string
  name: string
  description: string
  response: string
  ephemeral: boolean
  enabled: boolean
}

interface TrackerProfile {
  id: string
  profile_url: string
  username: string
  channel_id: string
  live_notifications: boolean
  upload_notifications: boolean
  enabled: boolean
}

interface BotStatus {
  bot_tag: string | null
  state: string
  command_count: number
  tracker_count: number
  configuration_updated_at: string | null
  last_error: string | null
  last_seen_at: string
  online: boolean
}

interface DashboardPayload {
  settings: DashboardSettings
  modules: BotModule[]
  commands: BuiltInCommand[]
  customCommands: CustomCommand[]
  trackers: TrackerProfile[]
  status: BotStatus | null
}

interface MutationResponse {
  message?: string
}

function requestError(reason: unknown, fallback: string) {
  const message = reason instanceof Error ? reason.message : ''
  return message === 'Failed to fetch'
    ? 'The NIGHTRAID server connection was interrupted. Please try again.'
    : message || fallback
}

function Toggle({ checked, onChange, label, disabled = false }: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 rounded-full border transition-all duration-300 disabled:cursor-not-allowed disabled:opacity-35 ${
        checked
          ? 'border-blood bg-blood shadow-[0_0_24px_rgba(227,38,46,0.25)]'
          : 'border-bone/15 bg-black/50'
      }`}
    >
      <span className={`absolute left-[3px] top-[3px] h-[1.125rem] w-[1.125rem] rounded-full bg-bone shadow-[0_2px_8px_rgba(0,0,0,0.45)] transition-transform duration-300 ${checked ? 'translate-x-5' : 'translate-x-0'}`} />
    </button>
  )
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <span className="ln-label text-[0.5rem] text-bone/40">{children}</span>
}

function CustomCommandCard({ command, busy, onSave, onDelete }: {
  command: CustomCommand
  busy: boolean
  onSave: (command: CustomCommand) => Promise<void>
  onDelete: (command: CustomCommand) => Promise<void>
}) {
  const [draft, setDraft] = useState(command)
  useEffect(() => setDraft(command), [command])

  return (
    <div className="rounded-2xl border border-white/10 bg-[linear-gradient(145deg,rgba(255,255,255,0.045),rgba(255,255,255,0.015))] p-5 shadow-[0_20px_60px_rgba(0,0,0,0.18)]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="font-mono text-sm font-bold text-bone">/{draft.name}</p>
        <Toggle checked={draft.enabled} disabled={busy} label={`Enable /${draft.name}`} onChange={(enabled) => setDraft((current) => ({ ...current, enabled }))} />
      </div>
      <div className="mt-4 grid gap-3">
        <input value={draft.description} maxLength={100} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} className="h-10 rounded-xl border border-white/10 bg-black/25 px-3 text-xs text-bone outline-none focus:border-blood/60" aria-label={`Description for ${draft.name}`} />
        <textarea value={draft.response} maxLength={2000} rows={3} onChange={(event) => setDraft((current) => ({ ...current, response: event.target.value }))} className="resize-y rounded-xl border border-white/10 bg-black/25 p-3 text-xs leading-relaxed text-bone outline-none focus:border-blood/60" aria-label={`Response for ${draft.name}`} />
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-[0.65rem] text-bone/45">
          <input type="checkbox" checked={draft.ephemeral} onChange={(event) => setDraft((current) => ({ ...current, ephemeral: event.target.checked }))} className="accent-[#ab0f22]" />
          Only the user can see the reply
        </label>
        <div className="flex gap-2">
          <button type="button" disabled={busy} onClick={() => void onDelete(command)} className="inline-flex h-9 items-center gap-2 rounded-full border border-red-400/25 px-4 text-[0.55rem] font-bold uppercase tracking-[0.1em] text-red-300 disabled:opacity-40"><Trash2 className="h-3.5 w-3.5" /> Delete</button>
          <button type="button" disabled={busy} onClick={() => void onSave(draft)} className="inline-flex h-9 items-center gap-2 rounded-full bg-bone px-4 text-[0.55rem] font-extrabold uppercase tracking-[0.1em] text-paper disabled:opacity-40"><Save className="h-3.5 w-3.5" /> Save</button>
        </div>
      </div>
    </div>
  )
}

function TrackerCard({ tracker, busy, onSave, onDelete }: {
  tracker: TrackerProfile
  busy: boolean
  onSave: (tracker: TrackerProfile) => Promise<void>
  onDelete: (tracker: TrackerProfile) => Promise<void>
}) {
  const [draft, setDraft] = useState(tracker)
  useEffect(() => setDraft(tracker), [tracker])

  return (
    <div className="rounded-2xl border border-white/10 bg-[linear-gradient(145deg,rgba(255,255,255,0.045),rgba(255,255,255,0.015))] p-5 shadow-[0_20px_60px_rgba(0,0,0,0.18)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-bold text-bone">@{tracker.username}</p>
          <a href={tracker.profile_url} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-[0.62rem] text-bone/35 hover:text-blood">Open TikTok <ExternalLink className="h-3 w-3" /></a>
        </div>
        <Toggle checked={draft.enabled} disabled={busy} label={`Enable @${tracker.username}`} onChange={(enabled) => setDraft((current) => ({ ...current, enabled }))} />
      </div>
      <label className="mt-4 block">
        <FieldLabel>Discord notification channel ID</FieldLabel>
        <input value={draft.channel_id} inputMode="numeric" onChange={(event) => setDraft((current) => ({ ...current, channel_id: event.target.value.replace(/\D/g, '') }))} className="mt-2 h-10 w-full rounded-xl border border-white/10 bg-black/25 px-3 font-mono text-xs text-bone outline-none focus:border-blood/60" />
      </label>
      <div className="mt-4 flex flex-wrap gap-5 text-[0.65rem] text-bone/50">
        <label className="flex items-center gap-2"><input type="checkbox" checked={draft.live_notifications} onChange={(event) => setDraft((current) => ({ ...current, live_notifications: event.target.checked }))} className="accent-[#ab0f22]" /> Live alerts</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={draft.upload_notifications} onChange={(event) => setDraft((current) => ({ ...current, upload_notifications: event.target.checked }))} className="accent-[#ab0f22]" /> Upload alerts</label>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" disabled={busy} onClick={() => void onDelete(tracker)} className="inline-flex h-9 items-center gap-2 rounded-full border border-red-400/25 px-4 text-[0.55rem] font-bold uppercase tracking-[0.1em] text-red-300 disabled:opacity-40"><Trash2 className="h-3.5 w-3.5" /> Remove</button>
        <button type="button" disabled={busy} onClick={() => void onSave(draft)} className="inline-flex h-9 items-center gap-2 rounded-full bg-bone px-4 text-[0.55rem] font-extrabold uppercase tracking-[0.1em] text-paper disabled:opacity-40"><Save className="h-3.5 w-3.5" /> Save</button>
      </div>
    </div>
  )
}

export default function AdminDiscordBotPage() {
  const [session, setSession] = useState<AdminSession | null>(null)
  const [dashboard, setDashboard] = useState<DashboardPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [search, setSearch] = useState('')
  const [moduleFilter, setModuleFilter] = useState('all')
  const [newCommand, setNewCommand] = useState({ name: '', description: '', response: '', ephemeral: false })
  const [newTracker, setNewTracker] = useState({ profileUrl: '', channelId: '', liveNotifications: true, uploadNotifications: true })

  const loadDashboard = useCallback(async () => {
    const response = await fetch('/api/admin/bot-dashboard', { credentials: 'same-origin' })
    const payload = await response.json() as DashboardPayload & { message?: string }
    if (!response.ok) throw new Error(payload.message || 'Unable to load the Discord bot dashboard.')
    setDashboard(payload)
  }, [])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const sessionResponse = await fetch('/api/auth/session', { credentials: 'same-origin' })
        if (!sessionResponse.ok) throw new Error('Unable to verify the administrator session.')
        const nextSession = await sessionResponse.json() as AdminSession
        if (cancelled) return
        setSession(nextSession)
        if (nextSession.connected && nextSession.isAdmin) await loadDashboard()
      } catch (reason) {
        if (!cancelled) setError(requestError(reason, 'Unable to load the Discord bot dashboard.'))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [loadDashboard])

  useEffect(() => {
    if (!loading && session && (!session.connected || !session.isAdmin)) window.location.replace('/admin/login')
  }, [loading, session])

  useEffect(() => {
    if (!session?.isAdmin) return
    const timer = window.setInterval(() => {
      fetch('/api/admin/bot-dashboard', { credentials: 'same-origin' })
        .then(async (response) => response.ok ? await response.json() as DashboardPayload : null)
        .then((payload) => {
          if (payload) setDashboard((current) => current ? { ...current, status: payload.status } : payload)
        })
        .catch(() => undefined)
    }, 5_000)
    return () => window.clearInterval(timer)
  }, [session?.isAdmin])

  const mutate = async (body: unknown) => {
    if (busy) return false
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/admin/bot-dashboard', {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const payload = await response.json() as MutationResponse
      if (!response.ok) throw new Error(payload.message || 'The bot configuration could not be saved.')
      await loadDashboard()
      setNotice(payload.message || 'Bot configuration saved.')
      return true
    } catch (reason) {
      setError(requestError(reason, 'The bot configuration could not be saved.'))
      return false
    } finally {
      setBusy(false)
    }
  }

  const logout = async () => {
    if (busy) return
    setBusy(true)
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
      window.location.replace('/')
    } catch (reason) {
      setError(requestError(reason, 'Unable to log out.'))
      setBusy(false)
    }
  }

  const saveSettings = async () => {
    if (!dashboard) return
    await mutate({
      action: 'save-settings',
      disabledCommands: dashboard.settings.disabledCommands,
      modules: dashboard.settings.modules,
      presenceText: dashboard.settings.presenceText,
      presenceStatus: dashboard.settings.presenceStatus,
      presenceActivityType: dashboard.settings.presenceActivityType,
    })
  }

  const createCommand = async () => {
    const name = newCommand.name.trim().toLowerCase().replace(/^\//, '')
    const saved = await mutate({ action: 'create-command', command: { ...newCommand, name, enabled: true } })
    if (saved) setNewCommand({ name: '', description: '', response: '', ephemeral: false })
  }

  const createTracker = async () => {
    const saved = await mutate({ action: 'create-tracker', tracker: { ...newTracker, enabled: true } })
    if (saved) setNewTracker({ profileUrl: '', channelId: '', liveNotifications: true, uploadNotifications: true })
  }

  const filteredCommands = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!dashboard) return []
    return dashboard.commands.filter((command) => {
      const matchesModule = moduleFilter === 'all' || command.module === moduleFilter
      const matchesQuery = !query || command.name.includes(query) || command.description.toLowerCase().includes(query)
      return matchesModule && matchesQuery
    })
  }, [dashboard, moduleFilter, search])

  const moduleNames = useMemo(
    () => Object.fromEntries((dashboard?.modules ?? []).map((module) => [module.id, module.name])),
    [dashboard?.modules],
  )

  const enabledCommandCount = useMemo(() => {
    if (!dashboard) return 0
    return dashboard.commands.filter((command) =>
      !dashboard.settings.disabledCommands.includes(command.name)
      && dashboard.settings.modules[command.module] !== false).length
  }, [dashboard])

  const setCommandsEnabled = (commands: BuiltInCommand[], enabled: boolean) => {
    setDashboard((current) => {
      if (!current) return current
      const disabled = new Set(current.settings.disabledCommands)
      for (const command of commands) {
        if (enabled) disabled.delete(command.name)
        else disabled.add(command.name)
      }
      return { ...current, settings: { ...current.settings, disabledCommands: [...disabled] } }
    })
  }

  const status = dashboard?.status

  return (
    <PortalShell
      title="Discord bot"
      accent="command"
      kicker="Configure NIGHTRAID commands, bot presence, custom replies, and TikTok tracking from one secured control center."
      showHeaderDivider={false}
      headerAction={(
        <div className="flex items-center gap-4 sm:gap-6">
          <a href="/admin/applications" className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-[0.12em] text-bone/55 transition-colors hover:text-blood"><ArrowLeft className="h-4 w-4" /><span className="hidden sm:inline">Applications</span></a>
          <span className="h-4 w-px bg-bone/15" />
          <button type="button" disabled={busy} onClick={() => void logout()} className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-[0.12em] text-bone/55 transition-colors hover:text-blood disabled:opacity-40"><LogOut className="h-4 w-4" /> Logout</button>
        </div>
      )}
    >
      {loading ? (
        <div className="rounded-[2rem] border border-bone/10 bg-black/30 p-10 text-center text-sm text-bone/45">Connecting to the Discord bot...</div>
      ) : error && !dashboard ? (
        <div className="rounded-[2rem] border border-red-400/25 bg-red-400/5 p-7 text-sm leading-relaxed text-red-200">{error}</div>
      ) : dashboard ? (
        <div className="space-y-7">
          {error && <div className="rounded-2xl border border-red-400/25 bg-red-400/5 p-4 text-sm text-red-200">{error}</div>}
          {notice && <div className="flex items-center gap-2 rounded-2xl border border-emerald-400/25 bg-emerald-400/5 p-4 text-sm text-emerald-200"><Check className="h-4 w-4" />{notice}</div>}

          <section className="relative overflow-hidden rounded-[2.25rem] border border-white/10 bg-[radial-gradient(circle_at_12%_15%,rgba(227,38,46,0.18),transparent_28%),linear-gradient(135deg,rgba(28,9,12,0.92),rgba(8,8,8,0.96)_52%,rgba(16,16,16,0.92))] p-6 shadow-[0_35px_120px_rgba(0,0,0,0.38)] backdrop-blur-2xl sm:p-8 lg:p-10">
            <div className="pointer-events-none absolute -right-28 -top-32 h-80 w-80 rounded-full border border-blood/15" />
            <div className="pointer-events-none absolute -right-12 -top-16 h-52 w-52 rounded-full border border-blood/10" />
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-blood/70 to-transparent" />
            <div className="relative grid gap-8 lg:grid-cols-[minmax(0,1.35fr)_minmax(22rem,0.65fr)] lg:items-center">
              <div className="flex items-start gap-5 sm:gap-6">
                <span className="relative flex h-16 w-16 shrink-0 items-center justify-center rounded-[1.35rem] border border-[#7d87ff]/35 bg-[linear-gradient(145deg,rgba(88,101,242,0.28),rgba(88,101,242,0.08))] text-[#aeb4ff] shadow-[0_18px_50px_rgba(88,101,242,0.16)]">
                  <Bot className="h-7 w-7" />
                  <span className={`absolute -right-1 -top-1 h-3.5 w-3.5 rounded-full border-[3px] border-[#110b0c] ${status?.online ? 'bg-emerald-400' : 'bg-red-400'}`} />
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-3">
                    <p className="ln-label text-[0.5rem] text-blood">NR // Bot control</p>
                    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[0.5rem] font-extrabold uppercase tracking-[0.12em] ${status?.online ? 'border-emerald-300/20 bg-emerald-300/5 text-emerald-300' : 'border-red-300/20 bg-red-300/5 text-red-300'}`}>{status?.online ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}{status?.online ? 'Live' : 'Offline'}</span>
                  </div>
                  <h2 className="mt-3 truncate font-display text-[clamp(2.2rem,5vw,4.25rem)] uppercase leading-none text-bone">{status?.bot_tag || 'NIGHTRAID Bot'}</h2>
                  <p className="mt-4 max-w-xl text-xs leading-relaxed text-bone/45 sm:text-sm">A live command center for every NIGHTRAID automation. Changes are secured, versioned, and synchronized with Discord every three seconds.</p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-[1.4rem] border border-white/10 bg-black/25 p-5 shadow-inner shadow-black/20">
                  <div className="flex items-center justify-between"><Command className="h-4 w-4 text-blood" /><span className="text-[0.52rem] font-bold uppercase tracking-[0.12em] text-bone/25">Live</span></div>
                  <p className="mt-6 font-display text-4xl text-bone">{status?.command_count ?? enabledCommandCount}</p>
                  <p className="mt-1 text-[0.58rem] font-bold uppercase tracking-[0.12em] text-bone/35">Commands</p>
                </div>
                <div className="rounded-[1.4rem] border border-white/10 bg-black/25 p-5 shadow-inner shadow-black/20">
                  <div className="flex items-center justify-between"><Video className="h-4 w-4 text-blood" /><span className="text-[0.52rem] font-bold uppercase tracking-[0.12em] text-bone/25">Capacity</span></div>
                  <p className="mt-6 font-display text-4xl text-bone">{dashboard.trackers.length}<span className="ml-1 text-base text-bone/25">/100</span></p>
                  <p className="mt-1 text-[0.58rem] font-bold uppercase tracking-[0.12em] text-bone/35">TikTok profiles</p>
                </div>
              </div>
            </div>
          </section>

          <section className="grid gap-5 xl:grid-cols-[minmax(0,0.78fr)_minmax(0,1.22fr)]">
            <div className="relative overflow-hidden rounded-[2rem] border border-white/10 bg-[linear-gradient(145deg,rgba(255,255,255,0.05),rgba(255,255,255,0.015))] p-6 shadow-[0_28px_90px_rgba(0,0,0,0.22)] backdrop-blur-2xl sm:p-8">
              <div className="pointer-events-none absolute -bottom-20 -right-20 h-44 w-44 rounded-full border border-blood/10" />
              <div className="flex items-center justify-between gap-4">
                <div><p className="ln-label text-[0.5rem] text-blood">Bot identity</p><h2 className="mt-2 font-display text-3xl uppercase text-bone">Presence</h2></div>
                <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/10 bg-black/20"><Activity className="h-4 w-4 text-bone/45" /></span>
              </div>
              <div className="mt-7 grid gap-4 sm:grid-cols-2">
                <label className="sm:col-span-2"><FieldLabel>Activity text</FieldLabel><input value={dashboard.settings.presenceText} maxLength={128} onChange={(event) => setDashboard((current) => current ? { ...current, settings: { ...current.settings, presenceText: event.target.value } } : current)} className="mt-2 h-11 w-full rounded-xl border border-white/10 bg-black/25 px-4 text-sm text-bone outline-none focus:border-blood/60" /></label>
                <label><FieldLabel>Status</FieldLabel><select value={dashboard.settings.presenceStatus} onChange={(event) => setDashboard((current) => current ? { ...current, settings: { ...current.settings, presenceStatus: event.target.value as DashboardSettings['presenceStatus'] } } : current)} className="mt-2 h-11 w-full rounded-xl border border-white/10 bg-[#111] px-3 text-xs text-bone outline-none"><option value="online">Online</option><option value="idle">Idle</option><option value="dnd">Do not disturb</option><option value="invisible">Invisible</option></select></label>
                <label><FieldLabel>Activity</FieldLabel><select value={dashboard.settings.presenceActivityType} onChange={(event) => setDashboard((current) => current ? { ...current, settings: { ...current.settings, presenceActivityType: event.target.value as DashboardSettings['presenceActivityType'] } } : current)} className="mt-2 h-11 w-full rounded-xl border border-white/10 bg-[#111] px-3 text-xs text-bone outline-none"><option value="WATCHING">Watching</option><option value="PLAYING">Playing</option><option value="LISTENING">Listening</option><option value="COMPETING">Competing</option></select></label>
              </div>
            </div>

            <div className="rounded-[2rem] border border-white/10 bg-[linear-gradient(145deg,rgba(255,255,255,0.05),rgba(255,255,255,0.015))] p-6 shadow-[0_28px_90px_rgba(0,0,0,0.22)] backdrop-blur-2xl sm:p-8">
              <div className="flex items-center justify-between gap-4">
                <div><p className="ln-label text-[0.5rem] text-blood">Feature groups</p><h2 className="mt-2 font-display text-3xl uppercase text-bone">Modules</h2></div>
                <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/10 bg-black/20"><Layers3 className="h-4 w-4 text-bone/45" /></span>
              </div>
              <div className="mt-6 grid gap-2.5 sm:grid-cols-2">
                {dashboard.modules.map((module) => (
                  <div key={module.id} className={`group relative flex min-h-[5.25rem] items-center justify-between gap-4 overflow-hidden rounded-2xl border p-4 transition-all duration-300 ${dashboard.settings.modules[module.id] !== false ? 'border-white/10 bg-black/20 hover:border-blood/30 hover:bg-blood/[0.035]' : 'border-white/[0.06] bg-black/10'}`}>
                    <span className={`absolute inset-y-3 left-0 w-0.5 rounded-full transition-colors ${dashboard.settings.modules[module.id] !== false ? 'bg-blood' : 'bg-bone/10'}`} />
                    <div className="pl-1"><p className="text-sm font-bold text-bone">{module.name}</p><p className="mt-1 text-[0.62rem] leading-relaxed text-bone/35">{module.description}</p></div>
                    <Toggle checked={dashboard.settings.modules[module.id] !== false} label={`Enable ${module.name}`} onChange={(checked) => setDashboard((current) => current ? { ...current, settings: { ...current.settings, modules: { ...current.settings.modules, [module.id]: checked } } } : current)} />
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="relative overflow-hidden rounded-[2.25rem] border border-white/10 bg-[linear-gradient(160deg,rgba(20,20,20,0.96),rgba(8,8,8,0.98))] shadow-[0_35px_120px_rgba(0,0,0,0.3)] backdrop-blur-2xl">
            <div className="pointer-events-none absolute -left-32 top-24 h-72 w-72 rounded-full bg-blood/[0.035] blur-3xl" />
            <div className="relative border-b border-white/10 p-6 sm:p-8 lg:p-10">
              <div className="flex flex-wrap items-end justify-between gap-6">
                <div className="flex items-start gap-4">
                  <span className="mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-blood/25 bg-blood/10 text-blood"><Gauge className="h-5 w-5" /></span>
                  <div>
                    <p className="ln-label text-[0.5rem] text-blood">Command matrix</p>
                    <h2 className="mt-2 font-display text-4xl uppercase text-bone sm:text-5xl">Built-in controls</h2>
                    <p className="mt-3 max-w-xl text-xs leading-relaxed text-bone/35">Fine-tune what appears in Discord. Disabled commands remain safely installed in code and can be restored instantly.</p>
                  </div>
                </div>
                <div className="flex items-center gap-6 rounded-2xl border border-white/10 bg-black/25 px-5 py-3">
                  <div><p className="font-display text-2xl text-bone">{enabledCommandCount}</p><p className="text-[0.48rem] font-bold uppercase tracking-[0.12em] text-bone/30">Enabled</p></div>
                  <span className="h-8 w-px bg-white/10" />
                  <div><p className="font-display text-2xl text-bone/45">{dashboard.commands.length - enabledCommandCount}</p><p className="text-[0.48rem] font-bold uppercase tracking-[0.12em] text-bone/30">Disabled</p></div>
                </div>
              </div>

              <div className="mt-8 flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
                <div className="no-scrollbar flex gap-2 overflow-x-auto pb-1">
                  <button type="button" onClick={() => setModuleFilter('all')} className={`h-9 shrink-0 rounded-full border px-4 text-[0.54rem] font-extrabold uppercase tracking-[0.11em] transition-all ${moduleFilter === 'all' ? 'border-blood bg-blood text-white shadow-[0_8px_24px_rgba(227,38,46,0.2)]' : 'border-white/10 bg-white/[0.025] text-bone/40 hover:border-white/25 hover:text-bone'}`}>All {dashboard.commands.length}</button>
                  {dashboard.modules.map((module) => {
                    const count = dashboard.commands.filter((command) => command.module === module.id).length
                    return <button key={module.id} type="button" onClick={() => setModuleFilter(module.id)} className={`h-9 shrink-0 rounded-full border px-4 text-[0.54rem] font-extrabold uppercase tracking-[0.11em] transition-all ${moduleFilter === module.id ? 'border-blood bg-blood text-white shadow-[0_8px_24px_rgba(227,38,46,0.2)]' : 'border-white/10 bg-white/[0.025] text-bone/40 hover:border-white/25 hover:text-bone'}`}>{module.name} {count}</button>
                  })}
                </div>
                <label className="relative block w-full shrink-0 xl:w-80"><Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-bone/25" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search the command matrix" className="h-11 w-full rounded-full border border-white/10 bg-black/30 pl-11 pr-4 text-xs text-bone outline-none transition-colors placeholder:text-bone/20 focus:border-blood/60" /></label>
              </div>
            </div>

            <div className="relative p-6 sm:p-8 lg:p-10">
              <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
                <p className="text-[0.58rem] font-bold uppercase tracking-[0.12em] text-bone/30">Showing {filteredCommands.length} command{filteredCommands.length === 1 ? '' : 's'}</p>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setCommandsEnabled(filteredCommands, true)} className="inline-flex h-8 items-center gap-1.5 rounded-full border border-white/10 px-3 text-[0.5rem] font-extrabold uppercase tracking-[0.1em] text-bone/45 transition-colors hover:border-emerald-300/30 hover:text-emerald-200"><Power className="h-3 w-3" /> Enable visible</button>
                  <button type="button" onClick={() => setCommandsEnabled(filteredCommands, false)} className="inline-flex h-8 items-center gap-1.5 rounded-full border border-white/10 px-3 text-[0.5rem] font-extrabold uppercase tracking-[0.1em] text-bone/45 transition-colors hover:border-red-300/30 hover:text-red-200">Disable visible</button>
                </div>
              </div>

              <div className="grid gap-3 lg:grid-cols-2">
                {filteredCommands.map((command, index) => {
                  const moduleEnabled = dashboard.settings.modules[command.module] !== false
                  const enabled = !dashboard.settings.disabledCommands.includes(command.name) && moduleEnabled
                  return (
                    <div key={command.name} className={`group relative min-h-[7rem] overflow-hidden rounded-[1.35rem] border p-5 transition-all duration-300 ${enabled ? 'border-white/10 bg-[linear-gradient(145deg,rgba(255,255,255,0.045),rgba(255,255,255,0.012))] hover:-translate-y-0.5 hover:border-blood/30 hover:shadow-[0_18px_50px_rgba(0,0,0,0.24)]' : 'border-white/[0.06] bg-black/20'}`}>
                      <span className={`absolute inset-y-4 left-0 w-0.5 rounded-full ${enabled ? 'bg-blood' : 'bg-bone/10'}`} />
                      <div className="flex h-full items-start justify-between gap-5">
                        <div className="min-w-0 pl-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-[0.5rem] font-bold tracking-[0.12em] text-bone/20">{String(index + 1).padStart(2, '0')}</span>
                            <span className="rounded-full border border-white/[0.08] bg-black/20 px-2 py-1 text-[0.45rem] font-bold uppercase tracking-[0.1em] text-bone/30">{moduleNames[command.module] || command.module}</span>
                            {!moduleEnabled && <span className="rounded-full border border-amber-300/15 bg-amber-300/5 px-2 py-1 text-[0.45rem] font-bold uppercase tracking-[0.1em] text-amber-200/60">Module off</span>}
                          </div>
                          <p className={`mt-3 truncate font-mono text-sm font-extrabold ${enabled ? 'text-bone' : 'text-bone/45'}`}>/{command.name}</p>
                          <p className="mt-2 line-clamp-2 text-[0.65rem] leading-relaxed text-bone/[0.32]">{command.description}</p>
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-3">
                          <Toggle checked={enabled} disabled={!moduleEnabled} label={`Enable /${command.name}`} onChange={(checked) => setDashboard((current) => {
                            if (!current) return current
                            const disabled = new Set(current.settings.disabledCommands)
                            if (checked) disabled.delete(command.name); else disabled.add(command.name)
                            return { ...current, settings: { ...current.settings, disabledCommands: [...disabled] } }
                          })} />
                          <span className={`text-[0.46rem] font-extrabold uppercase tracking-[0.12em] ${enabled ? 'text-emerald-300/65' : 'text-bone/20'}`}>{enabled ? 'Active' : 'Inactive'}</span>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
              {filteredCommands.length === 0 && <div className="rounded-[1.35rem] border border-dashed border-white/10 p-10 text-center text-xs text-bone/30">No commands match this view.</div>}

              <div className="mt-7 flex flex-col gap-4 rounded-[1.35rem] border border-blood/15 bg-[linear-gradient(90deg,rgba(227,38,46,0.07),rgba(227,38,46,0.015))] p-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                <span className="flex items-center gap-3 text-[0.62rem] leading-relaxed text-bone/45"><ShieldCheck className="h-4 w-4 shrink-0 text-blood" /> Changes are applied atomically, so Discord never receives duplicate command registrations.</span>
                <button type="button" disabled={busy} onClick={() => void saveSettings()} className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-full bg-blood px-6 text-[0.62rem] font-extrabold uppercase tracking-[0.12em] text-white shadow-[0_12px_35px_rgba(227,38,46,0.22)] transition-all hover:bg-red-600 hover:shadow-[0_16px_45px_rgba(227,38,46,0.3)] disabled:opacity-40"><Save className="h-4 w-4" /> Save configuration</button>
              </div>
            </div>
          </section>

          <section className="grid gap-5 xl:grid-cols-2">
            <div className="relative overflow-hidden rounded-[2rem] border border-white/10 bg-[linear-gradient(145deg,rgba(255,255,255,0.05),rgba(255,255,255,0.015))] p-6 shadow-[0_28px_90px_rgba(0,0,0,0.22)] backdrop-blur-2xl sm:p-8">
              <div className="pointer-events-none absolute -right-20 -top-20 h-48 w-48 rounded-full border border-blood/10" />
              <div className="relative flex items-start justify-between gap-4"><div><p className="ln-label text-[0.5rem] text-blood">Command builder</p><h2 className="mt-2 font-display text-3xl uppercase text-bone">Custom commands</h2><p className="mt-2 text-xs leading-relaxed text-bone/35">Add safe text-response slash commands without redeploying the bot.</p></div><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-blood/20 bg-blood/10 text-blood"><Sparkles className="h-4 w-4" /></span></div>
              <div className="relative mt-7 grid gap-3 rounded-[1.35rem] border border-blood/15 bg-[linear-gradient(145deg,rgba(227,38,46,0.06),rgba(0,0,0,0.18))] p-5">
                <div className="grid gap-3 sm:grid-cols-2"><input value={newCommand.name} maxLength={32} onChange={(event) => setNewCommand((current) => ({ ...current, name: event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '') }))} placeholder="command-name" className="h-10 rounded-xl border border-white/10 bg-black/25 px-3 font-mono text-xs text-bone outline-none focus:border-blood/60" /><input value={newCommand.description} maxLength={100} onChange={(event) => setNewCommand((current) => ({ ...current, description: event.target.value }))} placeholder="Short description" className="h-10 rounded-xl border border-white/10 bg-black/25 px-3 text-xs text-bone outline-none focus:border-blood/60" /></div>
                <textarea value={newCommand.response} maxLength={2000} rows={4} onChange={(event) => setNewCommand((current) => ({ ...current, response: event.target.value }))} placeholder="Bot response" className="resize-y rounded-xl border border-white/10 bg-black/25 p-3 text-xs leading-relaxed text-bone outline-none focus:border-blood/60" />
                <div className="flex flex-wrap items-center justify-between gap-3"><label className="flex items-center gap-2 text-[0.65rem] text-bone/45"><input type="checkbox" checked={newCommand.ephemeral} onChange={(event) => setNewCommand((current) => ({ ...current, ephemeral: event.target.checked }))} className="accent-[#ab0f22]" /> Private reply</label><button type="button" disabled={busy || !newCommand.name || !newCommand.description || !newCommand.response} onClick={() => void createCommand()} className="inline-flex h-9 items-center gap-2 rounded-full bg-bone px-4 text-[0.55rem] font-extrabold uppercase tracking-[0.1em] text-paper disabled:opacity-35"><Plus className="h-3.5 w-3.5" /> Add command</button></div>
              </div>
              <div className="no-scrollbar mt-5 max-h-[36rem] space-y-3 overflow-y-auto pr-1">
                {dashboard.customCommands.map((command) => <CustomCommandCard key={command.id} command={command} busy={busy} onSave={async (draft) => { await mutate({ action: 'update-command', id: draft.id, command: { name: draft.name, description: draft.description, response: draft.response, ephemeral: draft.ephemeral, enabled: draft.enabled } }) }} onDelete={async (target) => { if (window.confirm(`Delete /${target.name}?`)) await mutate({ action: 'delete-command', id: target.id }) }} />)}
                {dashboard.customCommands.length === 0 && <p className="rounded-2xl border border-white/10 p-5 text-xs text-bone/35">No custom commands yet.</p>}
              </div>
            </div>

            <div className="relative overflow-hidden rounded-[2rem] border border-white/10 bg-[linear-gradient(145deg,rgba(255,255,255,0.05),rgba(255,255,255,0.015))] p-6 shadow-[0_28px_90px_rgba(0,0,0,0.22)] backdrop-blur-2xl sm:p-8">
              <div className="pointer-events-none absolute -right-20 -top-20 h-48 w-48 rounded-full border border-blood/10" />
              <div className="relative flex items-start justify-between gap-4"><div><p className="ln-label text-[0.5rem] text-blood">Social tracker</p><h2 className="mt-2 font-display text-3xl uppercase text-bone">TikTok profiles</h2><p className="mt-2 text-xs leading-relaxed text-bone/35">Add up to 100 creators. New profiles are baseline-seeded so an old upload is never announced as new.</p></div><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-blood/20 bg-blood/10 text-blood"><Video className="h-4 w-4" /></span></div>
              <div className="relative mt-7 grid gap-3 rounded-[1.35rem] border border-blood/15 bg-[linear-gradient(145deg,rgba(227,38,46,0.06),rgba(0,0,0,0.18))] p-5">
                <input value={newTracker.profileUrl} onChange={(event) => setNewTracker((current) => ({ ...current, profileUrl: event.target.value }))} placeholder="https://www.tiktok.com/@username" className="h-10 rounded-xl border border-white/10 bg-black/25 px-3 text-xs text-bone outline-none focus:border-blood/60" />
                <input value={newTracker.channelId} inputMode="numeric" onChange={(event) => setNewTracker((current) => ({ ...current, channelId: event.target.value.replace(/\D/g, '') }))} placeholder="Discord notification channel ID" className="h-10 rounded-xl border border-white/10 bg-black/25 px-3 font-mono text-xs text-bone outline-none focus:border-blood/60" />
                <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex flex-wrap gap-4 text-[0.65rem] text-bone/45"><label className="flex items-center gap-2"><input type="checkbox" checked={newTracker.liveNotifications} onChange={(event) => setNewTracker((current) => ({ ...current, liveNotifications: event.target.checked }))} className="accent-[#ab0f22]" /> Live alerts</label><label className="flex items-center gap-2"><input type="checkbox" checked={newTracker.uploadNotifications} onChange={(event) => setNewTracker((current) => ({ ...current, uploadNotifications: event.target.checked }))} className="accent-[#ab0f22]" /> Upload alerts</label></div><button type="button" disabled={busy || !newTracker.profileUrl || !newTracker.channelId} onClick={() => void createTracker()} className="inline-flex h-9 items-center gap-2 rounded-full bg-bone px-4 text-[0.55rem] font-extrabold uppercase tracking-[0.1em] text-paper disabled:opacity-35"><Plus className="h-3.5 w-3.5" /> Add profile</button></div>
              </div>
              <div className="no-scrollbar mt-5 max-h-[36rem] space-y-3 overflow-y-auto pr-1">
                {dashboard.trackers.map((tracker) => <TrackerCard key={tracker.id} tracker={tracker} busy={busy} onSave={async (draft) => { await mutate({ action: 'update-tracker', id: draft.id, tracker: { profileUrl: draft.profile_url, channelId: draft.channel_id, liveNotifications: draft.live_notifications, uploadNotifications: draft.upload_notifications, enabled: draft.enabled } }) }} onDelete={async (target) => { if (window.confirm(`Remove @${target.username} from the tracker?`)) await mutate({ action: 'delete-tracker', id: target.id }) }} />)}
                {dashboard.trackers.length === 0 && <p className="rounded-2xl border border-white/10 p-5 text-xs text-bone/35">No dashboard-managed TikTok profiles yet.</p>}
              </div>
            </div>
          </section>

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-[1.35rem] border border-white/10 bg-[linear-gradient(90deg,rgba(255,255,255,0.035),rgba(255,255,255,0.01))] px-5 py-4 text-[0.62rem] text-bone/35"><span className="flex items-center gap-2"><RefreshCw className="h-3.5 w-3.5 text-blood" /> Dashboard status refreshes every 5 seconds. Bot configuration applies every 3 seconds.</span>{status?.last_seen_at && <span className="rounded-full border border-white/10 px-3 py-1.5 text-[0.5rem] font-bold uppercase tracking-[0.1em] text-bone/30">Last heartbeat {new Date(status.last_seen_at).toLocaleString()}</span>}</div>
        </div>
      ) : null}
    </PortalShell>
  )
}
