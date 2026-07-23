import { FormEvent, ReactNode, useEffect, useState } from 'react'
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Gamepad2,
  MessageCircle,
  ShieldCheck,
  Unplug,
  UserRound,
} from 'lucide-react'
import SectionHeader from './SectionHeader'
import { useReveal } from '../hooks/useReveal'
import { ScrollTrigger } from '../lib/motion'
import { scrollToId } from '../lib/scroll'

const STEPS = [
  {
    label: 'Player profile',
    shortLabel: 'Profile',
    detail: 'Your identity and Discord account',
    icon: UserRound,
  },
  {
    label: 'Game & activity',
    shortLabel: 'Game',
    detail: 'Where and how often you play',
    icon: Gamepad2,
  },
  {
    label: 'Your story',
    shortLabel: 'Story',
    detail: 'Clan history and motivation',
    icon: MessageCircle,
  },
  {
    label: 'Review & consent',
    shortLabel: 'Review',
    detail: 'Confirm before sending',
    icon: ShieldCheck,
  },
] as const

const GAMES = [
  'Mobile Legends',
  'Bloodstrike',
] as const

const CONSENTS = [
  { key: 'accurate', label: 'I confirm that the information I provided is accurate.' },
  { key: 'rules', label: 'I agree to follow the NightRaid clan rules.' },
  { key: 'falseInfo', label: 'I understand that false information may result in rejection.' },
  { key: 'processing', label: 'I allow NightRaid to process and evaluate my application.' },
] as const

type ConsentKey = (typeof CONSENTS)[number]['key']

interface ApplicationData {
  inGameName: string
  ageGroup: string
  sex: string
  device: string
  games: string[]
  willingToUseClanTag: string
  playFrequency: string
  previousClan: string
  previousClanLeavingReason: string
  facebookProfileUrl: string
  discoverySource: string
  discoverySourceOther: string
  alreadyJoinedDiscord: string
  reasonForJoining: string
  consents: Record<ConsentKey, boolean>
}

const INITIAL_DATA: ApplicationData = {
  inGameName: '',
  ageGroup: '',
  sex: '',
  device: '',
  games: [],
  willingToUseClanTag: '',
  playFrequency: '',
  previousClan: '',
  previousClanLeavingReason: '',
  facebookProfileUrl: '',
  discoverySource: '',
  discoverySourceOther: '',
  alreadyJoinedDiscord: '',
  reasonForJoining: '',
  consents: {
    accurate: false,
    rules: false,
    falseInfo: false,
    processing: false,
  },
}

/* Keeps in-progress answers alive across the Discord OAuth round trip,
 * which navigates away from the page and back. */
const DRAFT_STORAGE_KEY = 'nightraid-application-draft'

function readDraft(): { step: number; data: ApplicationData } | null {
  try {
    const raw = sessionStorage.getItem(DRAFT_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { step?: unknown; data?: Partial<ApplicationData> | null } | null
    if (!parsed || typeof parsed !== 'object' || typeof parsed.step !== 'number' || !parsed.data || typeof parsed.data !== 'object') {
      return null
    }
    const saved = parsed.data
    return {
      step: Math.min(STEPS.length - 1, Math.max(0, Math.trunc(parsed.step))),
      data: {
        ...INITIAL_DATA,
        ...saved,
        games: Array.isArray(saved.games) ? saved.games.filter((game): game is string => typeof game === 'string') : [],
        consents: { ...INITIAL_DATA.consents, ...(saved.consents ?? {}) },
      },
    }
  } catch {
    return null
  }
}

function clearDraft() {
  try {
    sessionStorage.removeItem(DRAFT_STORAGE_KEY)
  } catch {
    /* Storage unavailable. */
  }
}

const inputClass =
  'mt-2 w-full rounded-2xl border border-bone/15 bg-black/25 px-4 py-3.5 text-sm text-bone placeholder:text-bone/30 transition-colors duration-300 hover:border-bone/30 focus:border-blood focus:outline-none'

function FieldLabel({ children, optional = false }: { children: ReactNode; optional?: boolean }) {
  return (
    <span className="ln-label block text-[0.6rem] text-bone/60">
      {children}
      {!optional && <span className="ml-1 text-blood">*</span>}
    </span>
  )
}

function FieldError({ children }: { children?: string }) {
  if (!children) return null
  return (
    <p className="mt-2 flex items-center gap-1.5 text-xs text-red-300" role="alert">
      <AlertCircle aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
      {children}
    </p>
  )
}

function ChoiceGroup({
  label,
  name,
  value,
  options,
  onChange,
  error,
  columns = 2,
  className,
}: {
  label: string
  name: string
  value: string
  options: readonly { label: string; value: string }[]
  onChange: (value: string) => void
  error?: string
  columns?: 2 | 3
  className?: string
}) {
  return (
    <fieldset className={className}>
      <legend>
        <FieldLabel>{label}</FieldLabel>
      </legend>
      <div className={`mt-2 grid gap-2 ${columns === 3 ? 'grid-cols-3' : 'grid-cols-2'}`} role="radiogroup" aria-label={label}>
        {options.map((option) => {
          const selected = option.value === value
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              name={name}
              onClick={() => onChange(option.value)}
              className={`min-h-11 rounded-xl border px-3.5 py-2.5 text-left text-xs font-bold uppercase tracking-[0.1em] transition-colors duration-300 ${
                selected
                  ? 'border-blood bg-blood text-bone'
                  : 'border-bone/15 bg-black/20 text-bone/55 hover:border-bone/35 hover:text-bone'
              }`}
            >
              <span className="flex items-center justify-between gap-2">
                {option.label}
                {selected && <Check aria-hidden="true" className="h-4 w-4" />}
              </span>
            </button>
          )
        })}
      </div>
      <FieldError>{error}</FieldError>
    </fieldset>
  )
}

function isFacebookUrl(value: string) {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      ['facebook.com', 'www.facebook.com', 'm.facebook.com'].includes(url.hostname.toLowerCase())
    )
  } catch {
    return false
  }
}

export default function Application() {
  const revealRef = useReveal<HTMLDivElement>({ selector: '[data-reveal]', stagger: 0.1 })
  const [step, setStep] = useState(() => readDraft()?.step ?? 0)
  const [data, setData] = useState<ApplicationData>(() => readDraft()?.data ?? INITIAL_DATA)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const [applicationId, setApplicationId] = useState('')
  const [discordUsername, setDiscordUsername] = useState('')
  const [sessionLoading, setSessionLoading] = useState(true)
  const [disconnecting, setDisconnecting] = useState(false)
  const [connectionError, setConnectionError] = useState('')

  useEffect(() => {
    let cancelled = false
    const params = new URLSearchParams(window.location.search)
    if (params.get('discord_error')) {
      setConnectionError('Discord could not be connected. Please try again.')
    }

    fetch('/api/auth/session', { credentials: 'same-origin' })
      .then(async (response) => {
        if (!response.ok) throw new Error('Unable to check the Discord session.')
        return (await response.json()) as { connected?: boolean; discordUsername?: string }
      })
      .then((session) => {
        if (!cancelled && session.connected && session.discordUsername) {
          setDiscordUsername(session.discordUsername)
          setConnectionError('')
        }
      })
      .catch(() => {
        if (!cancelled) setConnectionError('The Discord session service is currently unavailable.')
      })
      .finally(() => {
        if (!cancelled) setSessionLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (applicationId) return
    try {
      sessionStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify({ step, data }))
    } catch {
      /* Storage unavailable. */
    }
  }, [step, data, applicationId])

  /* Bring the confirmation into view: the form above collapses on success,
   * which would otherwise leave the viewport stranded mid-page. */
  useEffect(() => {
    if (!applicationId) return
    ScrollTrigger.refresh()
    scrollToId('apply')
  }, [applicationId])

  const update = <K extends keyof ApplicationData>(key: K, value: ApplicationData[K]) => {
    setData((current) => ({ ...current, [key]: value }))
    setErrors((current) => {
      if (!current[key]) return current
      const next = { ...current }
      delete next[key]
      return next
    })
  }

  const toggleGame = (game: string) => {
    update(
      'games',
      data.games.includes(game) ? data.games.filter((item) => item !== game) : [...data.games, game],
    )
  }

  const disconnectDiscord = async () => {
    if (disconnecting) return
    setDisconnecting(true)
    setConnectionError('')

    try {
      const response = await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
      })
      if (!response.ok) throw new Error('Unable to disconnect Discord.')
      setDiscordUsername('')
    } catch (reason) {
      setConnectionError(reason instanceof Error ? reason.message : 'Unable to disconnect Discord.')
    } finally {
      setDisconnecting(false)
    }
  }

  const validateStep = (targetStep: number) => {
    const nextErrors: Record<string, string> = {}

    if (targetStep === 0) {
      const ign = data.inGameName.trim()
      if (!ign) nextErrors.inGameName = 'Enter your in-game name.'
      else if (ign.length < 2 || ign.length > 50) nextErrors.inGameName = 'Use between 2 and 50 characters.'
      if (!data.ageGroup) nextErrors.ageGroup = 'Choose your age group.'
      if (!data.sex) nextErrors.sex = 'Choose an option.'
      if (!data.device) nextErrors.device = 'Choose your main device.'
    }

    if (targetStep === 1) {
      if (data.games.length === 0) nextErrors.games = 'Select at least one game.'
      if (!data.willingToUseClanTag) nextErrors.willingToUseClanTag = 'Choose an option.'
      if (!data.playFrequency) nextErrors.playFrequency = 'Choose how often you play.'
    }

    if (targetStep === 2) {
      if (!data.previousClan.trim()) nextErrors.previousClan = 'Enter your previous clan, or write None.'
      if (!data.previousClanLeavingReason.trim()) {
        nextErrors.previousClanLeavingReason = 'Tell us why you left, or explain that this is your first clan.'
      }
      if (!data.facebookProfileUrl.trim()) nextErrors.facebookProfileUrl = 'Enter your Facebook profile link.'
      else if (!isFacebookUrl(data.facebookProfileUrl.trim())) {
        nextErrors.facebookProfileUrl = 'Use a valid facebook.com profile link beginning with https://.'
      }
      if (!data.discoverySource) nextErrors.discoverySource = 'Tell us where you found NightRaid.'
      if (data.discoverySource === 'Others' && !data.discoverySourceOther.trim()) {
        nextErrors.discoverySourceOther = 'Please specify where you found us.'
      }
      if (!data.alreadyJoinedDiscord) nextErrors.alreadyJoinedDiscord = 'Choose an option.'
      if (!data.reasonForJoining.trim()) nextErrors.reasonForJoining = 'Tell us why you want to join NightRaid.'
    }

    if (targetStep === 3) {
      if (!discordUsername) nextErrors.discord = 'Connect Discord before submitting your application.'
      if (!CONSENTS.every(({ key }) => data.consents[key])) {
        nextErrors.consents = 'All four confirmations are required.'
      }
    }

    setErrors(nextErrors)
    return Object.keys(nextErrors).length === 0
  }

  const nextStep = () => {
    if (!validateStep(step)) return
    setStep((current) => Math.min(STEPS.length - 1, current + 1))
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!validateStep(3)) return

    setSubmitting(true)
    setSubmitError('')
    try {
      const response = await fetch('/api/clan-applications', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inGameName: data.inGameName.trim(),
          ageGroup: data.ageGroup,
          sex: data.sex,
          device: data.device,
          games: data.games,
          willingToUseClanTag: data.willingToUseClanTag === 'Yes',
          playFrequency: data.playFrequency,
          previousClan: data.previousClan.trim(),
          previousClanLeavingReason: data.previousClanLeavingReason.trim(),
          facebookProfileUrl: data.facebookProfileUrl.trim(),
          discoverySource: data.discoverySource,
          discoverySourceOther: data.discoverySourceOther.trim() || undefined,
          alreadyJoinedDiscord: data.alreadyJoinedDiscord === 'Yes',
          reasonForJoining: data.reasonForJoining.trim(),
          consents: data.consents,
        }),
      })
      const contentType = response.headers.get('content-type') || ''
      const result = contentType.includes('application/json')
        ? ((await response.json()) as { applicationId?: string; message?: string })
        : null
      if (!response.ok || !result?.applicationId) throw new Error(result?.message || 'Application service unavailable')
      clearDraft()
      setApplicationId(result.applicationId)
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'The application could not be submitted.')
    } finally {
      setSubmitting(false)
    }
  }

  const currentStep = STEPS[step]

  return (
    <section
      id="apply"
      data-theme="dark"
      aria-labelledby="apply-title"
      className="relative isolate overflow-hidden"
    >
      <div ref={revealRef} className="relative mx-auto w-full max-w-[110rem] px-5 py-24 sm:px-8 sm:py-32 lg:px-12">
        <SectionHeader
          id="apply-title"
          reveal={false}
          title="Join the"
          accent="raid"
          tone="dark"
          align="center"
          kicker="One form. One honest shot. Tell us how you play, what you stand for, and why NightRaid should be your next squad."
        />

        <div data-reveal className="overflow-hidden rounded-[2rem] border border-bone/15 bg-[#080808]/90">
          <div className="h-1 bg-bone/10">
            <div
              className="h-full bg-blood transition-[width] duration-500 ease-cine"
              style={{ width: `${((step + 1) / STEPS.length) * 100}%` }}
            />
          </div>

          <div className="grid grid-cols-[minmax(0,1fr)] lg:grid-cols-[19rem_minmax(0,1fr)]">
            <aside className="min-w-0 border-b border-bone/10 bg-bone/[0.025] p-5 sm:p-7 lg:flex lg:flex-col lg:border-b-0 lg:border-r lg:p-8">
              <div className="no-scrollbar flex gap-2 overflow-x-auto pb-2 lg:block lg:space-y-3 lg:overflow-visible lg:pb-0">
                {STEPS.map((item, index) => {
                  const Icon = item.icon
                  const active = index === step
                  const complete = index < step
                  return (
                    <button
                      key={item.label}
                      type="button"
                      onClick={() => {
                        if (index <= step || validateStep(step)) setStep(index)
                      }}
                      aria-current={active ? 'step' : undefined}
                      className={`group flex min-w-[9.5rem] items-center gap-3 rounded-2xl border px-3.5 py-3 text-left transition-colors lg:w-full lg:min-w-0 lg:px-4 lg:py-4 ${
                        active
                          ? 'border-blood bg-blood text-bone'
                          : 'border-bone/10 bg-transparent text-bone/45 hover:border-bone/25 hover:text-bone'
                      }`}
                    >
                      <span
                        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full border ${
                          active ? 'border-bone/25 bg-black/10' : complete ? 'border-blood bg-blood text-bone' : 'border-bone/15'
                        }`}
                      >
                        {complete ? <Check className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
                      </span>
                      <span className="min-w-0">
                        <span className="ln-label block text-[0.5rem] opacity-60">0{index + 1}</span>
                        <span className="mt-0.5 block text-xs font-bold uppercase tracking-[0.08em] lg:hidden">
                          {item.shortLabel}
                        </span>
                        <span className="mt-0.5 hidden text-xs font-bold uppercase tracking-[0.08em] lg:block">
                          {item.label}
                        </span>
                        <span className="mt-1 hidden text-[0.68rem] leading-relaxed opacity-55 lg:block">{item.detail}</span>
                      </span>
                    </button>
                  )
                })}
              </div>

              <a
                href="/application/status"
                className="group mt-3 flex items-center gap-3 rounded-2xl border border-bone/10 bg-transparent px-3.5 py-3 text-left text-bone/45 transition-colors hover:border-bone/25 hover:text-bone lg:mt-auto lg:px-4 lg:py-4"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-bone/15">
                  <ArrowRight className="h-4 w-4" />
                </span>
                <span className="min-w-0">
                  <span className="ln-label block text-[0.5rem] opacity-60">Portal</span>
                  <span className="mt-0.5 block text-xs font-bold uppercase tracking-[0.08em]">Check your application</span>
                  <span className="mt-1 hidden text-[0.68rem] leading-relaxed opacity-55 lg:block">Track your submitted application</span>
                </span>
              </a>
            </aside>

            <form onSubmit={submit} noValidate className="min-w-0 p-5 sm:p-8 lg:p-12">
              {applicationId ? (
                <div className="flex min-h-[34rem] flex-col items-center justify-center py-16 text-center">
                  <span className="flex h-20 w-20 items-center justify-center rounded-full border border-emerald-400/25 bg-emerald-400/10 text-emerald-300">
                    <CheckCircle2 className="h-9 w-9" />
                  </span>
                  <p className="ln-label mt-8 text-emerald-300">Application received</p>
                  <h3 className="mt-3 font-display text-4xl uppercase text-bone sm:text-6xl">You are in the queue.</h3>
                  <p className="mt-5 max-w-lg text-sm leading-relaxed text-bone/55">
                    Your application is pending review. Save this reference to track your application status. Your Discord session is now disconnected, and this confirmation will remain here until you choose where to go next.
                  </p>
                  <div className="mt-8 rounded-2xl border border-bone/15 bg-bone/5 px-6 py-4">
                    <span className="ln-label text-[0.55rem] text-bone/40">Application ID</span>
                    <strong className="mt-1 block font-display text-2xl uppercase tracking-wide text-bone">{applicationId}</strong>
                  </div>
                  <a href="/application/status" className="ln-pill mt-8">
                    Track application <ArrowRight className="h-4 w-4" />
                  </a>
                </div>
              ) : (
                <>
                  <div className="mb-9 flex items-start justify-between gap-5 border-b border-bone/10 pb-7">
                    <div>
                      <p className="ln-label text-[0.58rem] text-blood">Step {step + 1} of {STEPS.length}</p>
                      <h3 className="mt-2 font-display text-3xl uppercase leading-none text-bone sm:text-4xl">{currentStep.label}</h3>
                    </div>
                    <span className="hidden font-serif text-6xl italic leading-none text-bone/5 sm:block">0{step + 1}</span>
                  </div>

                  {step === 0 && (
                    <div className="space-y-7">
                      <div className={`rounded-2xl border p-4 sm:flex sm:items-center sm:justify-between sm:gap-6 ${discordUsername ? 'border-emerald-400/25 bg-emerald-400/5' : 'border-[#5865F2]/35 bg-[#5865F2]/10'}`}>
                        <div className="min-w-0">
                          <p className="text-sm font-bold text-bone">
                            {sessionLoading ? 'Checking Discord...' : discordUsername || 'Connect your Discord'}
                          </p>
                          <p className="mt-1 text-xs leading-relaxed text-bone/45">
                            {discordUsername ? 'Discord account connected and ready for verification.' : 'Required for identity verification and approved-member onboarding.'}
                          </p>
                        </div>
                        {!sessionLoading && !discordUsername && (
                          <a href="/api/auth/discord?returnTo=%2Fapply" className="mt-4 inline-flex h-10 items-center justify-center rounded-full bg-[#5865F2] px-5 text-[0.62rem] font-extrabold uppercase tracking-[0.12em] text-white transition-colors hover:bg-[#4752c4] sm:mt-0">
                            Continue with Discord
                          </a>
                        )}
                        {!sessionLoading && discordUsername && (
                          <button
                            type="button"
                            disabled={disconnecting}
                            onClick={() => void disconnectDiscord()}
                            aria-label="Disconnect Discord account"
                            title="Disconnect Discord"
                            className="mt-4 flex h-10 w-10 shrink-0 items-center justify-center bg-transparent text-bone/45 transition-colors hover:text-blood disabled:cursor-wait disabled:opacity-35 sm:mt-0"
                          >
                            <Unplug className="h-5 w-5" />
                          </button>
                        )}
                      </div>
                      <FieldError>{connectionError}</FieldError>
                      <FieldError>{errors.discord}</FieldError>

                      <label className="block">
                        <FieldLabel>In-game name (IGN)</FieldLabel>
                        <input
                          type="text"
                          value={data.inGameName}
                          maxLength={50}
                          autoComplete="nickname"
                          onChange={(event) => update('inGameName', event.target.value)}
                          placeholder="Your player name"
                          className={inputClass}
                        />
                        <FieldError>{errors.inGameName}</FieldError>
                      </label>

                      <div className="grid max-w-3xl gap-6 sm:grid-cols-2">
                        <ChoiceGroup
                          label="How old are you?"
                          name="ageGroup"
                          value={data.ageGroup}
                          options={[{ label: '18 below', value: 'UNDER_18' }, { label: '18 above', value: 'AGE_18_OR_ABOVE' }]}
                          onChange={(value) => update('ageGroup', value)}
                          error={errors.ageGroup}
                        />
                        <ChoiceGroup
                          label="Main device"
                          name="device"
                          value={data.device}
                          options={[{ label: 'PC', value: 'PC' }, { label: 'Mobile', value: 'Mobile' }]}
                          onChange={(value) => update('device', value)}
                          error={errors.device}
                        />
                      </div>

                      <ChoiceGroup
                        label="Gender"
                        name="sex"
                        value={data.sex}
                        columns={3}
                        className="max-w-xl"
                        options={[
                          { label: 'Male', value: 'Male' },
                          { label: 'Female', value: 'Female' },
                          { label: 'Other', value: 'Other' },
                        ]}
                        onChange={(value) => update('sex', value)}
                        error={errors.sex}
                      />

                      <p className="flex items-start gap-2 text-xs leading-relaxed text-bone/35">
                        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-blood" />
                        Age and gender are profile information. Gender is never used for the approval decision.
                      </p>
                    </div>
                  )}

                  {step === 1 && (
                    <div className="space-y-8">
                      <fieldset>
                        <legend><FieldLabel>Which game are you applying for?</FieldLabel></legend>
                        <p className="mt-2 text-xs text-bone/35">Select every division you actively play.</p>
                        <div className="mt-4 grid max-w-xl grid-cols-2 gap-2 sm:gap-3">
                          {GAMES.map((game) => {
                            const selected = data.games.includes(game)
                            return (
                              <button
                                key={game}
                                type="button"
                                role="checkbox"
                                aria-checked={selected}
                                onClick={() => toggleGame(game)}
                                className={`min-h-[4.5rem] rounded-2xl border p-3 text-left transition-colors ${selected ? 'border-blood bg-blood text-bone' : 'border-bone/15 bg-black/20 text-bone/55 hover:border-bone/35 hover:text-bone'}`}
                              >
                                <Gamepad2 className="h-4 w-4" />
                                <span className="mt-3 block text-[0.68rem] font-bold uppercase leading-tight tracking-[0.08em]">{game}</span>
                              </button>
                            )
                          })}
                        </div>
                        <FieldError>{errors.games}</FieldError>
                      </fieldset>

                      <fieldset>
                        <legend><FieldLabel>How often do you play?</FieldLabel></legend>
                        <div className="mt-2 grid max-w-2xl gap-2 sm:grid-cols-3">
                          {['Everyday', '3 times a week', 'Once a week'].map((frequency) => {
                            const selected = frequency === data.playFrequency
                            return (
                              <button
                                key={frequency}
                                type="button"
                                role="radio"
                                aria-checked={selected}
                                onClick={() => update('playFrequency', frequency)}
                                className={`flex min-h-11 w-full items-center justify-between rounded-xl border px-4 py-2.5 text-left text-xs font-bold uppercase tracking-[0.08em] transition-colors ${selected ? 'border-blood bg-blood text-bone' : 'border-bone/15 bg-black/20 text-bone/55 hover:border-bone/35 hover:text-bone'}`}
                              >
                                {frequency}
                                {selected && <Check className="h-4 w-4" />}
                              </button>
                            )
                          })}
                        </div>
                        <FieldError>{errors.playFrequency}</FieldError>
                      </fieldset>

                      <ChoiceGroup
                        label="Willing to use our clan tag?"
                        name="clanTag"
                        value={data.willingToUseClanTag}
                        className="max-w-sm"
                        options={[{ label: 'Yes', value: 'Yes' }, { label: 'No', value: 'No' }]}
                        onChange={(value) => update('willingToUseClanTag', value)}
                        error={errors.willingToUseClanTag}
                      />
                    </div>
                  )}

                  {step === 2 && (
                    <div className="space-y-7">
                      <label className="block">
                        <FieldLabel>Previous clan</FieldLabel>
                        <input
                          type="text"
                          value={data.previousClan}
                          onChange={(event) => update('previousClan', event.target.value)}
                          placeholder="Write None if this is your first clan"
                          className={inputClass}
                        />
                        <FieldError>{errors.previousClan}</FieldError>
                      </label>

                      <label className="block">
                        <FieldLabel>Why did you leave your previous clan?</FieldLabel>
                        <textarea
                          value={data.previousClanLeavingReason}
                          onChange={(event) => update('previousClanLeavingReason', event.target.value)}
                          placeholder="Give us the honest context. Simple English is completely fine."
                          rows={4}
                          className={`${inputClass} resize-y`}
                        />
                        <FieldError>{errors.previousClanLeavingReason}</FieldError>
                      </label>

                      <label className="block">
                        <FieldLabel>Facebook profile link</FieldLabel>
                        <input
                          type="url"
                          value={data.facebookProfileUrl}
                          onChange={(event) => update('facebookProfileUrl', event.target.value)}
                          placeholder="https://facebook.com/your-profile"
                          autoComplete="url"
                          className={inputClass}
                        />
                        <p className="mt-2 text-xs text-bone/30">Used for contact only, not treated as verified identity.</p>
                        <FieldError>{errors.facebookProfileUrl}</FieldError>
                      </label>

                      <div className="grid gap-6 lg:grid-cols-2">
                        <fieldset>
                          <legend><FieldLabel>Where did you find us?</FieldLabel></legend>
                          <div className="mt-2 grid grid-cols-2 gap-2">
                            {['Facebook', 'TikTok', 'Discord', 'Others'].map((source) => {
                              const selected = data.discoverySource === source
                              return (
                                <button
                                  key={source}
                                  type="button"
                                  role="radio"
                                  aria-checked={selected}
                                  onClick={() => update('discoverySource', source)}
                                  className={`min-h-11 rounded-xl border px-3 py-2 text-xs font-bold uppercase tracking-[0.08em] transition-colors ${selected ? 'border-blood bg-blood text-bone' : 'border-bone/15 bg-black/20 text-bone/55 hover:border-bone/35 hover:text-bone'}`}
                                >
                                  {source}
                                </button>
                              )
                            })}
                          </div>
                          <FieldError>{errors.discoverySource}</FieldError>
                          {data.discoverySource === 'Others' && (
                            <label className="mt-3 block">
                              <span className="sr-only">Please specify where you found NightRaid</span>
                              <input
                                type="text"
                                value={data.discoverySourceOther}
                                onChange={(event) => update('discoverySourceOther', event.target.value)}
                                placeholder="Please specify"
                                className={inputClass}
                              />
                              <FieldError>{errors.discoverySourceOther}</FieldError>
                            </label>
                          )}
                        </fieldset>

                        <ChoiceGroup
                          label="Already in our Discord server?"
                          name="inDiscord"
                          value={data.alreadyJoinedDiscord}
                          options={[{ label: 'Yes', value: 'Yes' }, { label: 'No', value: 'No' }]}
                          onChange={(value) => update('alreadyJoinedDiscord', value)}
                          error={errors.alreadyJoinedDiscord}
                        />
                      </div>

                      <label className="block rounded-2xl border border-blood/25 bg-blood/5 p-4 sm:p-5">
                        <FieldLabel>Why do you want to join NIGHTRAID BG?</FieldLabel>
                        <textarea
                          value={data.reasonForJoining}
                          onChange={(event) => update('reasonForJoining', event.target.value)}
                          placeholder="Tell us what you want from the community and what kind of teammate you will be."
                          rows={5}
                          className={`${inputClass} bg-black/35 resize-y`}
                        />
                        <FieldError>{errors.reasonForJoining}</FieldError>
                      </label>
                    </div>
                  )}

                  {step === 3 && (
                    <div className="space-y-8">
                      <div className="grid gap-3 sm:grid-cols-3">
                        <div className="rounded-2xl border border-bone/10 bg-bone/[0.025] p-4">
                          <span className="ln-label text-[0.5rem] text-bone/35">Player</span>
                          <strong className="mt-2 block truncate text-sm text-bone">{data.inGameName || 'Not added'}</strong>
                        </div>
                        <div className="rounded-2xl border border-bone/10 bg-bone/[0.025] p-4">
                          <span className="ln-label text-[0.5rem] text-bone/35">Games</span>
                          <strong className="mt-2 block text-sm text-bone">{data.games.length} selected</strong>
                        </div>
                        <div className="rounded-2xl border border-bone/10 bg-bone/[0.025] p-4">
                          <span className="ln-label text-[0.5rem] text-bone/35">Discord</span>
                          <strong className={`mt-2 block truncate text-sm ${discordUsername ? 'text-emerald-300' : 'text-amber-300'}`}>{discordUsername || 'Not connected'}</strong>
                        </div>
                      </div>

                      <div className="rounded-2xl border border-bone/10 bg-black/25 p-5 sm:p-6">
                        <p className="ln-label text-[0.6rem] text-bone/60">Required confirmations</p>
                        <div className="mt-5 space-y-3">
                          {CONSENTS.map(({ key, label }) => {
                            const checked = data.consents[key]
                            return (
                              <label key={key} className="flex cursor-pointer items-start gap-3 rounded-xl border border-transparent p-2 transition-colors hover:border-bone/10 hover:bg-bone/[0.025]">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => {
                                    setData((current) => ({
                                      ...current,
                                      consents: { ...current.consents, [key]: !current.consents[key] },
                                    }))
                                    setErrors((current) => {
                                      const next = { ...current }
                                      delete next.consents
                                      return next
                                    })
                                  }}
                                  className="sr-only"
                                />
                                <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${checked ? 'border-blood bg-blood text-bone' : 'border-bone/25 text-transparent'}`}>
                                  <Check className="h-3.5 w-3.5" />
                                </span>
                                <span className="text-sm leading-relaxed text-bone/65">{label}</span>
                              </label>
                            )
                          })}
                        </div>
                        <FieldError>{errors.consents}</FieldError>
                      </div>

                      {!discordUsername && (
                        <div className="flex flex-col gap-4 rounded-2xl border border-amber-300/25 bg-amber-300/5 p-4 sm:flex-row sm:items-center sm:justify-between">
                          <p className="flex items-start gap-2 text-xs leading-relaxed text-amber-100/70">
                            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
                            Connect Discord to verify your account and enable onboarding if approved.
                          </p>
                          <a href="/api/auth/discord?returnTo=%2Fapply" className="inline-flex h-10 shrink-0 items-center justify-center rounded-full bg-[#5865F2] px-5 text-[0.6rem] font-extrabold uppercase tracking-[0.12em] text-white">
                            Connect Discord
                          </a>
                        </div>
                      )}
                      <FieldError>{errors.discord}</FieldError>
                      {submitError && (
                        <div className="rounded-2xl border border-red-400/25 bg-red-400/5 p-4 text-sm leading-relaxed text-red-200" role="alert">
                          {submitError}
                        </div>
                      )}
                    </div>
                  )}

                  <div className="mt-10 flex items-center justify-between gap-4 border-t border-bone/10 pt-7">
                    <button
                      type="button"
                      onClick={() => setStep((current) => Math.max(0, current - 1))}
                      disabled={step === 0}
                      className="inline-flex h-12 items-center gap-2 rounded-full border border-bone/20 px-5 text-[0.65rem] font-bold uppercase tracking-[0.12em] text-bone/60 transition-colors hover:border-bone/50 hover:text-bone disabled:cursor-default disabled:opacity-0"
                    >
                      <ArrowLeft className="h-4 w-4" /> Back
                    </button>

                    {step < STEPS.length - 1 ? (
                      <button type="button" onClick={nextStep} className="ln-pill">
                        Continue <ArrowRight className="h-4 w-4" />
                      </button>
                    ) : (
                      <button type="submit" disabled={submitting} className="ln-pill min-w-[11rem] disabled:cursor-wait disabled:opacity-60">
                        {submitting ? 'Sending...' : 'Submit application'}
                        {!submitting && <ArrowRight className="h-4 w-4" />}
                      </button>
                    )}
                  </div>
                </>
              )}
            </form>
          </div>
        </div>

      </div>
    </section>
  )
}
