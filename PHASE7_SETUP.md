# Phase 7 — Security and reliability

Phase 7 is implemented in the application. One Supabase migration and one deployment are required to activate it.

## 1. Run the Supabase migration

1. Open the Supabase dashboard for the NightRaid project.
2. Open **SQL Editor** and create a new query.
3. Copy all of `database/phase7.sql` into the editor.
4. Select **Run** and confirm that it completes without an error.

The migration creates:

- `clan_bans` — recoverable Discord, IGN, and Facebook applicant bans.
- `security_audit_logs` — append-only records for submissions, decisions, retries, exports, and ban changes.
- `rate_limit_buckets` and `consume_rate_limit(...)` — concurrency-safe, server-side throttling.

All three tables use Row Level Security. Only the server's Supabase service role can access them.

## 2. Deploy the updated project

Deploy only after the migration succeeds. The new code deliberately refuses protected writes if the security rate limiter is unavailable.

No new environment variables are required. Phase 7 uses the existing `APPLICATION_SIGNING_SECRET` to HMAC network identifiers before storage.

After deployment, sign in with Discord again. Phase 7 adds an issuer and audience to session tokens, so sessions created by an older deployment are intentionally invalid.

## 3. Verify the controls

1. Sign in at `/admin/applications` with an ID listed in `ADMIN_DISCORD_IDS`.
2. Open **Security and audit**.
3. Select an applicant and choose **Ban selected**.
4. Confirm the ban appears and can be deactivated without deleting its history.
5. Submit a test application and confirm an `APPLICATION_SUBMITTED` event appears.
6. Approve or reject a test application and confirm the decision appears in the audit history.

Submission limits are 5 attempts per Discord account and network address in 15 minutes, followed by a 30-minute block. Administrator writes are limited to 30 actions in 5 minutes, followed by a 10-minute block.

## Plan coverage

- Audit logs: implemented and immutable after insertion.
- Retries: AI, Messenger, Discord onboarding, and Excel synchronization remain available in the dashboard and are audited.
- Duplicate protection: database partial unique index plus an application pre-check.
- Webhook security: Meta HMAC signature verification, signed expiring postbacks, authorized PSID checks, and webhook-event idempotency.
- Encrypted token storage: Discord OAuth tokens remain AES-256-GCM encrypted at rest.
- Backup alerts: failed Messenger administrator delivery falls back to the configured Discord administrator channel.
- Text validation: strict Zod schemas, length limits, trimming, enum allowlists, and Facebook URL restrictions.
- Uploaded files: the application does not accept file uploads, so no untrusted upload path exists.
- AI safety: sex and other sensitive traits are excluded from scoring; recommendations remain advisory and manually overridable.

## Important secret cleanup

Before public launch, rotate every Supabase, Discord, and Meta secret or access token that has ever been pasted into a chat or shown in a screenshot. Update the Vercel environment variables with the rotated values and redeploy. Do not put secrets in `VITE_*` variables or commit `.env.local`.
