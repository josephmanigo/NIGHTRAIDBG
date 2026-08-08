# NIGHTRAID Discord Bot Dashboard

The secured dashboard is available at `/admin/discord-bot` after deployment.
It uses the same Discord administrator session as `/admin/applications`.

## One-time database setup

Run [`database/phase18.sql`](database/phase18.sql) in the Supabase SQL editor.
The migration creates the bot settings, custom commands, TikTok tracker profiles,
and Render heartbeat tables. All four tables use row-level security and are
accessible only through the service-role clients already used by the site and bot.

## Deployment

Deploy the same revision to both services:

1. Vercel serves the dashboard and authenticated `/api/admin/bot-dashboard` API.
2. Render runs `bot/nickname-bot.js` and applies saved configuration every three seconds.

Both services already require `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, and
`DISCORD_GUILD_ID`. `BOT_DASHBOARD_SYNC_MS` is optional and defaults to `3000`;
values are clamped between 2 and 60 seconds.

The dashboard supports:

- bot presence text, status, and activity type;
- module and individual built-in slash-command toggles;
- safe custom text-response slash commands;
- up to 100 TikTok profiles with per-profile channel and alert settings;
- bot heartbeat, applied command count, and tracker count.

Custom command replies disable Discord mention parsing. Newly added TikTok
profiles are not activated until their current upload/live baseline is fetched,
which prevents an existing post from being announced as new.
