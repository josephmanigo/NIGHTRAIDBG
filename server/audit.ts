import type { VercelRequest } from '@vercel/node'
import type { Json } from './database.types.js'
import { requestFingerprint } from './request-security.js'
import { getSupabaseAdmin } from './supabase.js'

export type AuditActorType = 'APPLICANT' | 'ADMIN' | 'MESSENGER_ADMIN' | 'SYSTEM'
export type AuditOutcome = 'SUCCESS' | 'DENIED' | 'FAILED'

export async function recordAuditEvent(input: {
  actorType: AuditActorType
  actorId?: string | null
  action: string
  applicationId?: string | null
  targetType?: string | null
  targetId?: string | null
  outcome?: AuditOutcome
  details?: Json
  request?: VercelRequest
}) {
  const fingerprint = input.request ? requestFingerprint(input.request) : null
  const { error } = await getSupabaseAdmin().from('security_audit_logs').insert({
    actor_type: input.actorType,
    actor_id: input.actorId ?? null,
    action: input.action.slice(0, 100),
    application_id: input.applicationId ?? null,
    target_type: input.targetType?.slice(0, 100) ?? null,
    target_id: input.targetId?.slice(0, 200) ?? null,
    outcome: input.outcome ?? 'SUCCESS',
    details: input.details ?? {},
    ip_address_hash: fingerprint?.ipAddressHash ?? null,
    user_agent_hash: fingerprint?.userAgentHash ?? null,
    request_id: fingerprint?.requestId ?? null,
  })

  if (error) {
    // Auditing is best-effort so a migration problem never changes a completed decision.
    console.error('Security audit event could not be recorded:', error.message)
  }
}
