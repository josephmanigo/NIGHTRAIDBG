// Routed through the consolidated Vercel API function.
import { z } from 'zod'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { allowAdminMutation, getAdminSession } from '../../server/admin-request.js'
import { recordAuditEvent } from '../../server/audit.js'
import {
  BOT_COMMAND_NAMES,
  BOT_COMMANDS,
  BOT_MODULES,
  normalizeModuleSettings,
} from '../../server/bot-dashboard-config.js'
import { env } from '../../server/env.js'
import { hasTrustedOrigin, methodNotAllowed, noStore, requestBody } from '../../server/http.js'
import { getSupabaseAdmin } from '../../server/supabase.js'

const snowflake = z.string().trim().regex(/^\d{16,22}$/)
const presenceStatus = z.enum(['online', 'idle', 'dnd', 'invisible'])
const activityType = z.enum(['PLAYING', 'WATCHING', 'LISTENING', 'COMPETING'])
const moduleSettingsSchema = z.object({
  rules: z.boolean(),
  announcements: z.boolean(),
  minigames: z.boolean(),
  leaderboards: z.boolean(),
  music: z.boolean(),
  watchparty: z.boolean(),
  live_tools: z.boolean(),
  social_tracker: z.boolean(),
  scoreboard: z.boolean(),
}).strict()

const customCommandFields = z.object({
  name: z.string().trim().toLowerCase().regex(/^[a-z0-9_-]{1,32}$/),
  description: z.string().trim().min(1).max(100),
  response: z.string().trim().min(1).max(2000),
  ephemeral: z.boolean().default(false),
  enabled: z.boolean().default(true),
}).strict()

const trackerFields = z.object({
  profileUrl: z.string().trim().url().max(300),
  channelId: snowflake,
  liveNotifications: z.boolean().default(true),
  uploadNotifications: z.boolean().default(true),
  enabled: z.boolean().default(true),
}).strict()

const actionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('save-settings'),
    disabledCommands: z.array(z.string().trim()).max(100),
    modules: moduleSettingsSchema,
    presenceText: z.string().trim().min(1).max(128),
    presenceStatus,
    presenceActivityType: activityType,
  }).strict(),
  z.object({ action: z.literal('create-command'), command: customCommandFields }).strict(),
  z.object({ action: z.literal('update-command'), id: z.string().uuid(), command: customCommandFields }).strict(),
  z.object({ action: z.literal('delete-command'), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal('create-tracker'), tracker: trackerFields }).strict(),
  z.object({ action: z.literal('update-tracker'), id: z.string().uuid(), tracker: trackerFields }).strict(),
  z.object({ action: z.literal('delete-tracker'), id: z.string().uuid() }).strict(),
])

function parseTikTokProfile(value: string) {
  try {
    const url = new URL(value)
    const hostname = url.hostname.toLowerCase().replace(/^www\./, '')
    if (hostname !== 'tiktok.com' && !hostname.endsWith('.tiktok.com')) return null
    const match = /^\/@([^/?#]+)/.exec(url.pathname)
    if (!match) return null
    const username = decodeURIComponent(match[1]).trim().replace(/^@/, '')
    if (!/^[a-zA-Z0-9._]{2,32}$/.test(username)) return null
    return { username, profileUrl: `https://www.tiktok.com/@${username}` }
  } catch {
    return null
  }
}

function settingsPayload(row: {
  disabled_commands: string[]
  module_settings: unknown
  presence_text: string
  presence_status: string
  presence_activity_type: string
  updated_at: string
} | null) {
  return {
    disabledCommands: row?.disabled_commands?.filter((name) => BOT_COMMAND_NAMES.has(name)) ?? [],
    modules: normalizeModuleSettings(row?.module_settings),
    presenceText: row?.presence_text || 'NIGHTRAID',
    presenceStatus: row?.presence_status || 'online',
    presenceActivityType: row?.presence_activity_type || 'WATCHING',
    updatedAt: row?.updated_at ?? null,
  }
}

async function loadDashboard(request: VercelRequest, response: VercelResponse) {
  noStore(response)
  const admin = await getAdminSession(request)
  if (!admin) return response.status(403).json({ message: 'Administrator access is required.' })

  const guildId = env.discordGuildId()
  const supabase = getSupabaseAdmin()
  const [settingsResult, commandsResult, trackersResult, statusResult] = await Promise.all([
    supabase.from('discord_bot_settings').select('*').eq('guild_id', guildId).maybeSingle(),
    supabase.from('discord_custom_commands').select('*').eq('guild_id', guildId).order('name'),
    supabase.from('discord_tracker_profiles').select('*').eq('guild_id', guildId).order('username'),
    supabase.from('discord_bot_status').select('*').eq('guild_id', guildId).maybeSingle(),
  ])

  const error = settingsResult.error || commandsResult.error || trackersResult.error || statusResult.error
  if (error) {
    console.error('Discord bot dashboard load failed:', error.message)
    return response.status(503).json({
      message: 'Discord bot dashboard storage is not ready. Apply database/phase18.sql in Supabase.',
      migrationRequired: true,
    })
  }

  const status = statusResult.data
  const lastSeenMs = status?.last_seen_at ? new Date(status.last_seen_at).getTime() : 0
  const online = Boolean(lastSeenMs && Date.now() - lastSeenMs < 20_000)

  return response.status(200).json({
    settings: settingsPayload(settingsResult.data),
    modules: BOT_MODULES,
    commands: BOT_COMMANDS,
    customCommands: commandsResult.data ?? [],
    trackers: trackersResult.data ?? [],
    status: status ? { ...status, online } : null,
  })
}

async function saveSettings(
  action: Extract<z.infer<typeof actionSchema>, { action: 'save-settings' }>,
  adminId: string,
) {
  if (action.disabledCommands.some((name) => !BOT_COMMAND_NAMES.has(name))) {
    return { status: 400, message: 'One or more command names are not supported.' }
  }
  const guildId = env.discordGuildId()
  const { error } = await getSupabaseAdmin().from('discord_bot_settings').upsert({
    guild_id: guildId,
    disabled_commands: [...new Set(action.disabledCommands)].sort(),
    module_settings: action.modules,
    presence_text: action.presenceText,
    presence_status: action.presenceStatus,
    presence_activity_type: action.presenceActivityType,
    updated_by: adminId,
  }, { onConflict: 'guild_id' })
  if (error) throw error
  return { status: 200, message: 'Bot settings saved. The live bot will apply them within a few seconds.' }
}

async function mutateCustomCommand(
  action: Extract<z.infer<typeof actionSchema>, { action: 'create-command' | 'update-command' | 'delete-command' }>,
  adminId: string,
) {
  const guildId = env.discordGuildId()
  const supabase = getSupabaseAdmin()
  if (action.action === 'delete-command') {
    const { data, error } = await supabase.from('discord_custom_commands').delete().eq('id', action.id).eq('guild_id', guildId).select('id').maybeSingle()
    if (error) throw error
    return data
      ? { status: 200, message: 'Custom command deleted.' }
      : { status: 404, message: 'Custom command not found.' }
  }

  if (BOT_COMMAND_NAMES.has(action.command.name)) {
    return { status: 409, message: `/${action.command.name} is already a built-in command.` }
  }
  const values = {
    guild_id: guildId,
    name: action.command.name,
    description: action.command.description,
    response: action.command.response,
    ephemeral: action.command.ephemeral,
    enabled: action.command.enabled,
  }
  const result = action.action === 'create-command'
    ? await supabase.from('discord_custom_commands').insert({ ...values, created_by: adminId }).select('*').single()
    : await supabase.from('discord_custom_commands').update(values).eq('id', action.id).eq('guild_id', guildId).select('*').maybeSingle()

  if (result.error) {
    if (result.error.code === '23505') return { status: 409, message: `/${action.command.name} already exists.` }
    throw result.error
  }
  if (!result.data) return { status: 404, message: 'Custom command not found.' }
  return {
    status: action.action === 'create-command' ? 201 : 200,
    message: `/${action.command.name} ${action.action === 'create-command' ? 'created' : 'updated'}.`,
    command: result.data,
  }
}

async function mutateTracker(
  action: Extract<z.infer<typeof actionSchema>, { action: 'create-tracker' | 'update-tracker' | 'delete-tracker' }>,
  adminId: string,
) {
  const guildId = env.discordGuildId()
  const supabase = getSupabaseAdmin()
  if (action.action === 'delete-tracker') {
    const { data, error } = await supabase.from('discord_tracker_profiles').delete().eq('id', action.id).eq('guild_id', guildId).select('id').maybeSingle()
    if (error) throw error
    return data
      ? { status: 200, message: 'TikTok profile removed from the tracker.' }
      : { status: 404, message: 'TikTok tracker profile not found.' }
  }

  const parsed = parseTikTokProfile(action.tracker.profileUrl)
  if (!parsed) return { status: 400, message: 'Enter a valid TikTok profile URL such as https://www.tiktok.com/@username.' }

  if (action.action === 'create-tracker') {
    const { count, error: countError } = await supabase
      .from('discord_tracker_profiles')
      .select('id', { count: 'exact', head: true })
      .eq('guild_id', guildId)
    if (countError) throw countError
    if ((count ?? 0) >= 100) return { status: 409, message: 'The dashboard supports up to 100 TikTok profiles.' }
  }

  const values = {
    guild_id: guildId,
    channel_id: action.tracker.channelId,
    platform: 'tiktok',
    profile_url: parsed.profileUrl,
    username: parsed.username,
    live_notifications: action.tracker.liveNotifications,
    upload_notifications: action.tracker.uploadNotifications,
    enabled: action.tracker.enabled,
  }
  const result = action.action === 'create-tracker'
    ? await supabase.from('discord_tracker_profiles').insert({ ...values, created_by: adminId }).select('*').single()
    : await supabase.from('discord_tracker_profiles').update(values).eq('id', action.id).eq('guild_id', guildId).select('*').maybeSingle()

  if (result.error) {
    if (result.error.code === '23505') return { status: 409, message: `@${parsed.username} is already in the TikTok tracker.` }
    throw result.error
  }
  if (!result.data) return { status: 404, message: 'TikTok tracker profile not found.' }
  return {
    status: action.action === 'create-tracker' ? 201 : 200,
    message: `@${parsed.username} ${action.action === 'create-tracker' ? 'added to' : 'updated in'} the TikTok tracker.`,
    tracker: result.data,
  }
}

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method === 'GET') return loadDashboard(request, response)
  if (request.method !== 'PATCH') return methodNotAllowed(response, ['GET', 'PATCH'])
  if (!hasTrustedOrigin(request)) return response.status(403).json({ message: 'Untrusted request origin.' })

  const admin = await getAdminSession(request)
  if (!admin) return response.status(403).json({ message: 'Administrator access is required.' })
  if (!(await allowAdminMutation(request, response, admin.discordUserId))) return

  const parsed = actionSchema.safeParse(requestBody(request))
  if (!parsed.success) return response.status(400).json({ message: 'The Discord bot dashboard request is invalid.' })

  try {
    const result = parsed.data.action === 'save-settings'
      ? await saveSettings(parsed.data, admin.discordUserId)
      : parsed.data.action.endsWith('command')
        ? await mutateCustomCommand(parsed.data as Extract<z.infer<typeof actionSchema>, { action: 'create-command' | 'update-command' | 'delete-command' }>, admin.discordUserId)
        : await mutateTracker(parsed.data as Extract<z.infer<typeof actionSchema>, { action: 'create-tracker' | 'update-tracker' | 'delete-tracker' }>, admin.discordUserId)

    if (result.status < 400) {
      await recordAuditEvent({
        actorType: 'ADMIN',
        actorId: admin.discordUserId,
        action: `DISCORD_BOT_${parsed.data.action.replaceAll('-', '_').toUpperCase()}`,
        targetType: 'discord_bot_dashboard',
        targetId: 'id' in parsed.data ? parsed.data.id : env.discordGuildId(),
        details: { action: parsed.data.action },
        request,
      })
    }
    return response.status(result.status).json(result)
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : String(reason)
    console.error('Discord bot dashboard mutation failed:', message)
    return response.status(503).json({
      message: message.includes('discord_bot_')
        ? 'Discord bot dashboard storage is not ready. Apply database/phase18.sql in Supabase.'
        : 'The Discord bot configuration could not be saved.',
    })
  }
}
