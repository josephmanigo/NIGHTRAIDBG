# NIGHTRAID Phase 5 Messenger setup

Phase 5 sends each completed application and its AI recommendation to allowlisted NIGHTRAID administrators through the Facebook Page, supports signed Approve/Reject/View actions, records decisions, and exposes safe delivery retries in the web administrator portal.

## 1. Apply the database migration

If the existing database already has Phases 1–4, paste and run the complete contents of `database/phase5.sql` in Supabase SQL Editor.

The migration adds:

- Messenger notification state to applications
- `messenger_admins`
- Per-recipient notification logs
- Idempotent webhook event records
- Atomic `application_decisions` audit records
- A protected database decision function used by both the web and Messenger controls

Fresh databases can run the updated `database/phase1.sql` instead.

## 2. Connect the NIGHTRAID Facebook Page

In Meta for Developers:

1. Open or create the Meta app owned by the NIGHTRAID organization.
2. Add the **Messenger** product.
3. Connect the official NIGHTRAID Facebook Page.
4. Generate a Page access token for that Page.
5. Copy the App ID and App Secret from the app's basic settings.
6. Copy the Page ID from the Page or Messenger settings.
7. Note the Graph API version currently selected by the Meta app, formatted like `vXX.X`.

Do not paste the Page access token or App Secret into chat, frontend code, or a public repository.

## 3. Add the backend variables

Generate `META_VERIFY_TOKEN` and `APPLICATION_SIGNING_SECRET` independently. For example, run this command twice and use a different output for each variable:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Add these variables to `.env.local` and the Vercel deployment environment:

```env
META_APP_ID=your-meta-app-id
META_APP_SECRET=your-private-meta-app-secret
META_PAGE_ID=your-nightraid-page-id
META_PAGE_ACCESS_TOKEN=your-private-page-access-token
META_VERIFY_TOKEN=your-random-webhook-verification-token
META_GRAPH_API_VERSION=vXX.X
APPLICATION_SIGNING_SECRET=your-separate-random-signing-secret

# Optional fallback when Messenger delivery fails
DISCORD_ADMIN_CHANNEL_ID=your-private-admin-channel-id
```

`APPLICATION_SIGNING_SECRET` signs every Messenger postback and must not reuse the session secret, token-encryption key, App Secret, or Page token.

## 4. Configure the webhook

Meta requires a public HTTPS callback. Deploy the site, then configure:

```text
Callback URL: https://YOUR-DOMAIN/api/webhooks/messenger
Verify token: the exact META_VERIFY_TOKEN value
```

Subscribe the Page to these webhook fields:

```text
messages
messaging_postbacks
```

The endpoint verifies `X-Hub-Signature-256` against `META_APP_SECRET` before parsing or processing the request. Replayed provider events are ignored by a unique event ID.

## 5. Register Messenger administrators

A Messenger administrator ID is a Page-scoped ID (PSID), not a public Facebook profile ID.

1. After the webhook is active, have the administrator send a message to the NIGHTRAID Page.
2. The event is safely recorded but ignored because the sender is not allowlisted yet.
3. In Supabase SQL Editor, find the recent PSID:

```sql
select sender_psid, max(received_at) as last_seen
from public.messenger_webhook_events
group by sender_psid
order by last_seen desc;
```

4. Register only the verified administrator:

```sql
insert into public.messenger_admins (
  facebook_psid,
  display_name,
  role,
  can_approve,
  can_reject
) values (
  'VERIFIED_PAGE_SCOPED_ID',
  'NIGHTRAID Administrator',
  'ADMIN',
  true,
  true
);
```

Set `can_approve` or `can_reject` to `false` for view-only or limited reviewers. Deactivate an administrator by setting `is_active = false`; do not delete audit history.

## 6. Meta messaging policy

The implementation sends non-promotional administrator updates with `messaging_type: UPDATE`. A registered administrator must have interacted with the Page and must remain eligible under Meta's current messaging-window and permission policies. Development-mode apps generally work only for app roles and testers. Production delivery may require the applicable Messenger permission review and a live app.

If Meta rejects delivery, the application remains `PENDING_REVIEW`, the error appears in `/admin/applications`, **Retry Messenger** becomes available, and an optional Discord administrator-channel alert is attempted.

## 7. Test Phase 5

Use test accounts and a test application before touching a real applicant:

1. Run `database/phase5.sql`.
2. Add all Phase 5 variables locally and in Vercel.
3. Deploy and complete Meta webhook verification.
4. Send a message from the administrator account to the NIGHTRAID Page and register its PSID.
5. Submit a test application.
6. Confirm Messenger receives the full summary and AI result.
7. Confirm **View Full Form** requires the existing Discord administrator login.
8. Test **Reject**, select a reason, and cancel once before testing confirmation.
9. Use a separate pending test application to test **Approve** and Discord onboarding.
10. Confirm `application_decisions`, `messenger_notification_logs`, and `messenger_webhook_events` contain the expected records.
11. Temporarily use an invalid test recipient to confirm the application stays pending and **Retry Messenger** appears.

Rotate the Supabase service-role key, Discord bot token, and Discord client secret previously shared in chat before connecting this system to the live Facebook Page.
