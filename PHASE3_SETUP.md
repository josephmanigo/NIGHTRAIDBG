# NightRaid Phase 3 Discord setup

Phase 3 verifies Discord membership when an application is submitted. After administrator approval, it adds the applicant to the NightRaid server, assigns every selected game role, sends a welcome DM, records the attempt, and exposes a safe retry action in the administrator portal.

## 1. Rotate the Discord credentials

Rotate the Discord bot token and client secret if either was shared in chat or another public location. Put only the replacement values in `.env.local` and the deployment environment.

## 2. Apply the database migration

If `database/phase1.sql` has already been run, paste and run the complete contents of `database/phase3.sql` in the Supabase SQL Editor.

The migration adds:

- Discord OAuth refresh-token storage
- Membership verification results
- Onboarding state and assigned roles
- Onboarding failure details
- `discord_onboarding_logs`

Fresh databases can run the updated `database/phase1.sql`, which already includes the Phase 3 fields.

## 3. Install the bot in NightRaid

In the Discord Developer Portal:

1. Open the NightRaid application.
2. Open **OAuth2 > URL Generator**.
3. Select the `bot` scope.
4. Grant only these bot permissions:
   - **Create Instant Invite** — required by Discord's Add Guild Member endpoint.
   - **Manage Roles** — required to assign the game roles.
5. Open the generated URL and install the bot in the NightRaid server.

In **Server Settings > Roles**, move the bot's role above every game role it must assign. Discord bots cannot manage roles above their highest role.

## 4. Create or verify the roles

Use these exact role names when role IDs are not configured:

```text
Bloodstrike
Mobile Legends
Honor of Kings
Farlight
Crossfire
Roblox
Dota 2
Valorant
```

Explicit role IDs are safer because roles can later be renamed. Enable Developer Mode in Discord, copy each role ID, and add the applicable variables:

```env
DISCORD_ROLE_BLOODSTRIKE_ID=
DISCORD_ROLE_MOBILE_LEGENDS_ID=
DISCORD_ROLE_HONOR_OF_KINGS_ID=
DISCORD_ROLE_FARLIGHT_ID=
DISCORD_ROLE_CROSSFIRE_ID=
DISCORD_ROLE_ROBLOX_ID=
DISCORD_ROLE_DOTA_2_ID=
DISCORD_ROLE_VALORANT_ID=
```

These IDs are optional. When one is blank, the backend searches for an exact case-insensitive role-name match.

## 5. Confirm required Discord variables

```env
DISCORD_CLIENT_ID=your-application-id
DISCORD_CLIENT_SECRET=your-rotated-client-secret
DISCORD_BOT_TOKEN=your-rotated-bot-token
DISCORD_GUILD_ID=your-nightraid-server-id
DISCORD_REDIRECT_URI=http://localhost:3000/api/auth/discord/callback
```

The applicant OAuth request already uses `identify guilds.join`. The bot token and OAuth application must belong to the same Discord application.

## 6. Test the complete flow

1. Start the full site with `npm run dev:full`.
2. Connect a non-administrator test Discord account through `/apply`.
3. Submit an application.
4. Confirm `discord_membership_verified` is populated in Supabase.
5. Sign in to `/admin/applications` with an ID in `ADMIN_DISCORD_IDS`.
6. Approve the test application.
7. Confirm the applicant joins the Discord server and receives the selected game roles.
8. Confirm the application becomes `COMPLETED` and an entry appears in `discord_onboarding_logs`.
9. If onboarding fails, correct the saved error and use **Retry Discord** in the administrator portal.

Users with Discord DMs disabled may not receive the welcome message. The saved onboarding error identifies that failure so an administrator can contact the applicant and retry.
