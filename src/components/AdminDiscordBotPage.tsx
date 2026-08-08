import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity,
  ArrowLeft,
  Bot,
  Check,
  Command,
  ExternalLink,
  LogOut,
  Plus,
  RefreshCw,
  Save,
  Search,
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
      className={`relative h-7 w-12 shrink-0 rounded-full border transition-colors disabled:opacity-40 ${
        checked ? 'border-blood bg-blood' : 'border-bone/20 bg-black/30'
      }`}
    >
      <span className={`absolute top-1 h-[1.1rem] w-[1.1rem] rounded-full bg-bone transition-transform ${checked ? 'translate-x-[1.55rem]' : 'translate-x-1'}`} />
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
    <div className="rounded-2xl border border-white/10 bg-white/[0.025] p-4">
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
    <div className="rounded-2xl border border-white/10 bg-white/[0.025] p-4">
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
    if (!dashboard || !query) return dashboard?.commands ?? []
    return dashboard.commands.filter((command) => command.name.includes(query) || command.description.toLowerCase().includes(query))
  }, [dashboard, search])

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
        <div className="space-y-5">
          {error && <div className="rounded-2xl border border-red-400/25 bg-red-400/5 p-4 text-sm text-red-200">{error}</div>}
          {notice && <div className="flex items-center gap-2 rounded-2xl border border-emerald-400/25 bg-emerald-400/5 p-4 text-sm text-emerald-200"><Check className="h-4 w-4" />{notice}</div>}

          <section className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_repeat(2,minmax(11rem,0.5fr))]">
            <div className="relative overflow-hidden rounded-[2rem] border border-white/10 bg-white/[0.045] p-6 backdrop-blur-2xl sm:p-8">
              <div className="absolute -right-16 -top-16 h-44 w-44 rounded-full border border-blood/20" />
              <div className="relative flex items-start gap-4">
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-[#5865F2]/35 bg-[#5865F2]/15 text-[#8993ff]"><Bot className="h-6 w-6" /></span>
                <div>
                  <p className="ln-label text-[0.5rem] text-bone/40">Render connection</p>
                  <h2 className="mt-2 font-display text-3xl uppercase text-bone">{status?.bot_tag || 'NIGHTRAID Bot'}</h2>
                  <p className={`mt-3 flex items-center gap-2 text-xs ${status?.online ? 'text-emerald-300' : 'text-red-300'}`}>{status?.online ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}{status?.online ? 'Online and syncing every 3 seconds' : 'Offline or waiting for the database migration'}</p>
                </div>
              </div>
            </div>
            <div className="rounded-[2rem] border border-white/10 bg-white/[0.03] p-6 backdrop-blur-xl">
              <Command className="h-5 w-5 text-blood" />
              <p className="mt-7 font-display text-4xl text-bone">{status?.command_count ?? dashboard.commands.length}</p>
              <p className="mt-2 ln-label text-[0.5rem] text-bone/35">Active commands</p>
            </div>
            <div className="rounded-[2rem] border border-white/10 bg-white/[0.03] p-6 backdrop-blur-xl">
              <Video className="h-5 w-5 text-blood" />
              <p className="mt-7 font-display text-4xl text-bone">{dashboard.trackers.length}<span className="ml-1 text-lg text-bone/25">/100</span></p>
              <p className="mt-2 ln-label text-[0.5rem] text-bone/35">TikTok profiles</p>
            </div>
          </section>

          <section className="grid gap-5 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
            <div className="rounded-[2rem] border border-white/10 bg-white/[0.035] p-6 backdrop-blur-2xl sm:p-8">
              <div className="flex items-center justify-between gap-4">
                <div><p className="ln-label text-[0.5rem] text-blood">Bot identity</p><h2 className="mt-2 font-display text-3xl uppercase text-bone">Presence</h2></div>
                <Activity className="h-5 w-5 text-bone/30" />
              </div>
              <div className="mt-7 grid gap-4 sm:grid-cols-2">
                <label className="sm:col-span-2"><FieldLabel>Activity text</FieldLabel><input value={dashboard.settings.presenceText} maxLength={128} onChange={(event) => setDashboard((current) => current ? { ...current, settings: { ...current.settings, presenceText: event.target.value } } : current)} className="mt-2 h-11 w-full rounded-xl border border-white/10 bg-black/25 px-4 text-sm text-bone outline-none focus:border-blood/60" /></label>
                <label><FieldLabel>Status</FieldLabel><select value={dashboard.settings.presenceStatus} onChange={(event) => setDashboard((current) => current ? { ...current, settings: { ...current.settings, presenceStatus: event.target.value as DashboardSettings['presenceStatus'] } } : current)} className="mt-2 h-11 w-full rounded-xl border border-white/10 bg-[#111] px-3 text-xs text-bone outline-none"><option value="online">Online</option><option value="idle">Idle</option><option value="dnd">Do not disturb</option><option value="invisible">Invisible</option></select></label>
                <label><FieldLabel>Activity</FieldLabel><select value={dashboard.settings.presenceActivityType} onChange={(event) => setDashboard((current) => current ? { ...current, settings: { ...current.settings, presenceActivityType: event.target.value as DashboardSettings['presenceActivityType'] } } : current)} className="mt-2 h-11 w-full rounded-xl border border-white/10 bg-[#111] px-3 text-xs text-bone outline-none"><option value="WATCHING">Watching</option><option value="PLAYING">Playing</option><option value="LISTENING">Listening</option><option value="COMPETING">Competing</option></select></label>
              </div>
            </div>

            <div className="rounded-[2rem] border border-white/10 bg-white/[0.035] p-6 backdrop-blur-2xl sm:p-8">
              <p className="ln-label text-[0.5rem] text-blood">Feature groups</p>
              <h2 className="mt-2 font-display text-3xl uppercase text-bone">Modules</h2>
              <div className="mt-6 grid gap-2 sm:grid-cols-2">
                {dashboard.modules.map((module) => (
                  <div key={module.id} className="flex items-center justify-between gap-4 rounded-2xl border border-white/10 bg-black/15 p-4">
                    <div><p className="text-sm font-bold text-bone">{module.name}</p><p className="mt-1 text-[0.62rem] leading-relaxed text-bone/35">{module.description}</p></div>
                    <Toggle checked={dashboard.settings.modules[module.id] !== false} label={`Enable ${module.name}`} onChange={(checked) => setDashboard((current) => current ? { ...current, settings: { ...current.settings, modules: { ...current.settings.modules, [module.id]: checked } } } : current)} />
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="rounded-[2rem] border border-white/10 bg-white/[0.035] p-6 backdrop-blur-2xl sm:p-8">
            <div className="flex flex-wrap items-end justify-between gap-5">
              <div><p className="ln-label text-[0.5rem] text-blood">Built in</p><h2 className="mt-2 font-display text-3xl uppercase text-bone">All commands</h2><p className="mt-2 text-xs text-bone/35">Disable individual slash commands without removing their code.</p></div>
              <label className="relative block w-full sm:w-72"><Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-bone/25" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search commands" className="h-11 w-full rounded-full border border-white/10 bg-black/20 pl-11 pr-4 text-xs text-bone outline-none focus:border-blood/60" /></label>
            </div>
            <div className="mt-7 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {filteredCommands.map((command) => {
                const enabled = !dashboard.settings.disabledCommands.includes(command.name) && dashboard.settings.modules[command.module] !== false
                return (
                  <div key={command.name} className={`flex items-center justify-between gap-4 rounded-2xl border p-4 ${enabled ? 'border-white/10 bg-black/15' : 'border-white/5 bg-black/10 opacity-55'}`}>
                    <div className="min-w-0"><p className="truncate font-mono text-xs font-bold text-bone">/{command.name}</p><p className="mt-1 line-clamp-2 text-[0.6rem] leading-relaxed text-bone/35">{command.description}</p></div>
                    <Toggle checked={enabled} disabled={dashboard.settings.modules[command.module] === false} label={`Enable /${command.name}`} onChange={(checked) => setDashboard((current) => {
                      if (!current) return current
                      const disabled = new Set(current.settings.disabledCommands)
                      if (checked) disabled.delete(command.name); else disabled.add(command.name)
                      return { ...current, settings: { ...current.settings, disabledCommands: [...disabled] } }
                    })} />
                  </div>
                )
              })}
            </div>
            <div className="mt-7 flex justify-end"><button type="button" disabled={busy} onClick={() => void saveSettings()} className="inline-flex h-11 items-center gap-2 rounded-full bg-blood px-6 text-[0.62rem] font-extrabold uppercase tracking-[0.12em] text-white disabled:opacity-40"><Save className="h-4 w-4" /> Save bot settings</button></div>
          </section>

          <section className="grid gap-5 xl:grid-cols-2">
            <div className="rounded-[2rem] border border-white/10 bg-white/[0.035] p-6 backdrop-blur-2xl sm:p-8">
              <p className="ln-label text-[0.5rem] text-blood">Command builder</p><h2 className="mt-2 font-display text-3xl uppercase text-bone">Custom commands</h2><p className="mt-2 text-xs leading-relaxed text-bone/35">Add safe text-response slash commands without redeploying the bot.</p>
              <div className="mt-7 grid gap-3 rounded-2xl border border-blood/15 bg-blood/[0.035] p-4">
                <div className="grid gap-3 sm:grid-cols-2"><input value={newCommand.name} maxLength={32} onChange={(event) => setNewCommand((current) => ({ ...current, name: event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '') }))} placeholder="command-name" className="h-10 rounded-xl border border-white/10 bg-black/25 px-3 font-mono text-xs text-bone outline-none focus:border-blood/60" /><input value={newCommand.description} maxLength={100} onChange={(event) => setNewCommand((current) => ({ ...current, description: event.target.value }))} placeholder="Short description" className="h-10 rounded-xl border border-white/10 bg-black/25 px-3 text-xs text-bone outline-none focus:border-blood/60" /></div>
                <textarea value={newCommand.response} maxLength={2000} rows={4} onChange={(event) => setNewCommand((current) => ({ ...current, response: event.target.value }))} placeholder="Bot response" className="resize-y rounded-xl border border-white/10 bg-black/25 p-3 text-xs leading-relaxed text-bone outline-none focus:border-blood/60" />
                <div className="flex flex-wrap items-center justify-between gap-3"><label className="flex items-center gap-2 text-[0.65rem] text-bone/45"><input type="checkbox" checked={newCommand.ephemeral} onChange={(event) => setNewCommand((current) => ({ ...current, ephemeral: event.target.checked }))} className="accent-[#ab0f22]" /> Private reply</label><button type="button" disabled={busy || !newCommand.name || !newCommand.description || !newCommand.response} onClick={() => void createCommand()} className="inline-flex h-9 items-center gap-2 rounded-full bg-bone px-4 text-[0.55rem] font-extrabold uppercase tracking-[0.1em] text-paper disabled:opacity-35"><Plus className="h-3.5 w-3.5" /> Add command</button></div>
              </div>
              <div className="no-scrollbar mt-5 max-h-[36rem] space-y-3 overflow-y-auto pr-1">
                {dashboard.customCommands.map((command) => <CustomCommandCard key={command.id} command={command} busy={busy} onSave={async (draft) => { await mutate({ action: 'update-command', id: draft.id, command: { name: draft.name, description: draft.description, response: draft.response, ephemeral: draft.ephemeral, enabled: draft.enabled } }) }} onDelete={async (target) => { if (window.confirm(`Delete /${target.name}?`)) await mutate({ action: 'delete-command', id: target.id }) }} />)}
                {dashboard.customCommands.length === 0 && <p className="rounded-2xl border border-white/10 p-5 text-xs text-bone/35">No custom commands yet.</p>}
              </div>
            </div>

            <div className="rounded-[2rem] border border-white/10 bg-white/[0.035] p-6 backdrop-blur-2xl sm:p-8">
              <p className="ln-label text-[0.5rem] text-blood">Social tracker</p><h2 className="mt-2 font-display text-3xl uppercase text-bone">TikTok profiles</h2><p className="mt-2 text-xs leading-relaxed text-bone/35">Add up to 100 creators. New profiles are baseline-seeded so an old upload is never announced as new.</p>
              <div className="mt-7 grid gap-3 rounded-2xl border border-blood/15 bg-blood/[0.035] p-4">
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

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/10 bg-black/20 px-5 py-4 text-[0.62rem] text-bone/35"><span className="flex items-center gap-2"><RefreshCw className="h-3.5 w-3.5" /> Dashboard status refreshes every 5 seconds. Bot configuration applies every 3 seconds.</span>{status?.last_seen_at && <span>Last heartbeat {new Date(status.last_seen_at).toLocaleString()}</span>}</div>
        </div>
      ) : null}
    </PortalShell>
  )
}
