import { useEffect, useState } from 'react'
import { ArrowRight, Check, LogIn, ShieldCheck, ShieldX } from 'lucide-react'
import PortalShell from './PortalShell'

interface AdminSession {
  connected: boolean
  discordUsername?: string
  isAdmin?: boolean
}

const ADMIN_OAUTH_URL = '/api/auth/discord?returnTo=%2Fadmin%2Flogin'

export default function AdminLoginPage() {
  const [session, setSession] = useState<AdminSession | null>(null)
  const [loading, setLoading] = useState(true)
  const [disconnecting, setDisconnecting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false

    fetch('/api/auth/session', { credentials: 'same-origin' })
      .then(async (response) => {
        if (!response.ok) throw new Error('Unable to verify the Discord session.')
        return (await response.json()) as AdminSession
      })
      .then((nextSession) => {
        if (cancelled) return
        setSession(nextSession)
        if (nextSession.connected && nextSession.isAdmin) {
          window.location.replace('/admin/applications')
        }
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : 'The administrator login is currently unavailable.')
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  const disconnect = async () => {
    if (disconnecting) return
    setDisconnecting(true)
    setError('')

    try {
      const response = await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
      })
      if (!response.ok) throw new Error('Unable to disconnect this Discord account.')
      setSession({ connected: false, isAdmin: false })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to disconnect this Discord account.')
    } finally {
      setDisconnecting(false)
    }
  }

  const accessDenied = Boolean(session?.connected && !session.isAdmin)

  return (
    <PortalShell
      title="Admin"
      accent="login"
      kicker="Secure access to NightRaid Application Command."
      showHeaderDivider={false}
    >
      <section className="relative mx-auto max-w-4xl overflow-hidden rounded-[2rem] border border-white/10 bg-white/[0.035] p-6 backdrop-blur-2xl sm:p-10 lg:p-12">
        <div aria-hidden="true" className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full border border-blood/15" />
        <div aria-hidden="true" className="pointer-events-none absolute -right-12 -top-12 h-40 w-40 rounded-full border border-blood/10" />

        <div className="relative grid gap-10 lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-end">
          <div>
            <span className="flex h-12 w-12 items-center justify-center rounded-full border border-bone/15 bg-black/20 text-bone">
              {accessDenied ? <ShieldX className="h-5 w-5 text-blood" /> : <ShieldCheck className="h-5 w-5" />}
            </span>

            <p className="ln-label mt-7 text-blood">{accessDenied ? 'Access denied' : 'Discord secured'}</p>
            <h2 className="mt-3 max-w-xl font-display text-[clamp(2.3rem,6vw,4.8rem)] uppercase leading-[0.92] text-bone">
              {accessDenied ? 'This account is not authorized.' : 'Enter application command.'}
            </h2>
            <p className="mt-5 max-w-xl text-sm leading-relaxed text-bone/50">
              {accessDenied
                ? `${session?.discordUsername || 'This Discord account'} is not one of the authorized NightRaid administrators.`
                : 'Continue with one of the two Discord accounts listed in ADMIN_DISCORD_IDS. Access is verified on the server before any application data is shown.'}
            </p>

            {error && (
              <p className="mt-5 rounded-2xl border border-blood/25 bg-blood/5 p-4 text-sm leading-relaxed text-red-200" role="alert">
                {error}
              </p>
            )}
          </div>

          <div className="rounded-2xl border border-white/10 bg-black/20 p-5">
            {loading || session?.isAdmin ? (
              <div className="flex min-h-28 flex-col justify-between">
                <p className="ln-label text-bone/35">Authorization</p>
                <p className="mt-6 flex items-center gap-2 text-sm text-bone/60">
                  <Check className="h-4 w-4 text-blood" />
                  {session?.isAdmin ? 'Access confirmed. Redirecting...' : 'Checking Discord session...'}
                </p>
              </div>
            ) : accessDenied ? (
              <button
                type="button"
                disabled={disconnecting}
                onClick={() => void disconnect()}
                className="flex min-h-28 w-full flex-col items-start justify-between text-left disabled:opacity-50"
              >
                <span className="ln-label text-bone/35">Wrong account</span>
                <span className="flex w-full items-center justify-between gap-4 text-xs font-extrabold uppercase tracking-[0.12em] text-bone transition-colors hover:text-blood">
                  {disconnecting ? 'Disconnecting...' : 'Use another account'}
                  <ArrowRight className="h-4 w-4" />
                </span>
              </button>
            ) : (
              <a href={ADMIN_OAUTH_URL} className="group flex min-h-28 flex-col justify-between">
                <span className="ln-label text-bone/35">Administrator access</span>
                <span className="flex items-center justify-between gap-4 text-xs font-extrabold uppercase tracking-[0.12em] text-bone transition-colors group-hover:text-blood">
                  <span className="flex items-center gap-2">
                    <LogIn className="h-4 w-4" /> Continue with Discord
                  </span>
                  <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
                </span>
              </a>
            )}
          </div>
        </div>
      </section>
    </PortalShell>
  )
}
