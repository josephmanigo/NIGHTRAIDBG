# NightRaid Phase 1 setup

Phase 1 includes the complete application form, Discord sign-in, server-side validation, encrypted Discord token storage, Supabase persistence, duplicate active-application protection, and applicant status tracking. A basic administrator review page is also included as a head start on Phase 2.

## 1. Rotate exposed credentials

Rotate any Supabase secret, Discord client secret, or Discord bot token that was shared in chat or another public location. Put only the replacement values in `.env.local` and in the deployment environment.

Never prefix a server secret with `VITE_`; Vite variables are exposed to browser code.

## 2. Create the database tables

1. Open the Supabase project dashboard.
2. Open **SQL Editor** and create a new query.
3. Paste the complete contents of `database/phase1.sql`.
4. Run the query once.
5. In **Table Editor**, confirm these tables exist:
   - `discord_connections`
   - `clan_applications`
   - `admin_users`

Row Level Security is enabled and the browser receives no direct table access. All access goes through the server API.

## 3. Configure Discord OAuth

In the Discord Developer Portal, add the exact local redirect URL configured in `.env.local`:

```text
http://localhost:3000/api/auth/discord/callback
```

For production, add a second redirect using the deployed site domain:

```text
https://your-domain.example/api/auth/discord/callback
```

The application's OAuth scopes are `identify` and `guilds.join`. Automatic server onboarding and Discord role assignment are Phase 3; Phase 1 securely stores the OAuth grant for that later step.

## 4. Required environment variables

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SECRET_KEY=your-rotated-server-secret

DISCORD_CLIENT_ID=your-discord-application-id
DISCORD_CLIENT_SECRET=your-rotated-discord-client-secret
DISCORD_REDIRECT_URI=http://localhost:3000/api/auth/discord/callback

SESSION_SECRET=at-least-32-random-bytes
TOKEN_ENCRYPTION_KEY=exactly-32-random-bytes
ADMIN_DISCORD_IDS=your-discord-user-id
APP_URL=http://localhost:3000
```

Generate `SESSION_SECRET` and `TOKEN_ENCRYPTION_KEY` independently. Do not reuse either value as another credential.

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Use the first output for `SESSION_SECRET` and the second for `TOKEN_ENCRYPTION_KEY`.

## 5. Run the complete local app

```powershell
npm run dev:full
```

The first Vercel CLI run may ask you to sign in and link the local directory. Use the URL printed by the command; if its port is not `3000`, update `APP_URL`, `DISCORD_REDIRECT_URI`, and the Discord Developer Portal redirect to the exact same origin and restart the command.

The normal `npm run dev` command serves only the visual Vite frontend and cannot execute the `/api` routes.

## 6. Verify Phase 1

1. Open `/apply` or scroll to **Join NightRaid** below Merch.
2. Select **Connect Discord** and authorize the application.
3. Complete all four form steps and submit.
4. Confirm the row appears in Supabase under `clan_applications` with status `PENDING_REVIEW`.
5. Open `/application/status` while signed in and confirm the same application number and status appear.
6. Submit again and confirm the active-application duplicate check blocks it.
7. Open `/admin/applications` using a Discord account listed in `ADMIN_DISCORD_IDS` to review the application.

## Deployment

Deploy to Vercel and add the same environment variable names in **Project Settings > Environment Variables**, using production URLs and rotated production secrets. Then add the production Discord callback URL before testing sign-in on the deployed site.
