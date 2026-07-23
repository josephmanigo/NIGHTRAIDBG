# NIGHTRAID Phase 8 — Nickname bot

Phase 8 adds a Discord bot process that watches the nickname channel. When a member sends a message there, the bot renames them to the clan format and marks the message:

- Member sends `Yepo` → their server nickname becomes `NIGHT • Yepo`.
- The bot reacts with ✅ on the message once the rename is done (or if the nickname already matches), so everyone can see who has been renamed already.
- The bot reacts with ⚠️ when it cannot rename the member (the server owner, or someone with a role above the bot).

Messages that already include the prefix (`NIGHT • Yepo`, `NIGHT - Yepo`) are handled without doubling it, and nicknames are trimmed to Discord's 32-character limit.

## Renaming someone else

Mentioning a member renames **them** instead of the sender:

- `NIGHT - ego @yepo` (or `@yepo ego` — the order does not matter) sets @yepo's nickname to `NIGHT • ego`.
- Anyone in the channel can rename themselves or a mentioned member — there is no permission requirement. Restrict who can post in the nickname channel if that gets abused.
- The reply-ping on a reply does not count as a mention — only mentions typed into the message body pick a target.
- Discord's limits still apply to the target: the server owner and members with a role above the bot cannot be renamed (⚠️).

## Why this is a separate process

Discord only delivers channel messages over a persistent gateway (WebSocket) connection. The Vercel serverless functions cannot hold one open, so the bot runs as its own long-lived Node process (`bot/nickname-bot.js`). It must be hosted somewhere that stays online — a spare PC, a VPS, or a worker on Railway/Render/Fly. It reuses the same bot token as the rest of the system.

## 1. Enable the privileged intents

1. Open https://discord.com/developers/applications and select the NIGHTRAID application.
2. Open **Bot** in the sidebar.
3. Under **Privileged Gateway Intents**, enable:
   - **SERVER MEMBERS INTENT**
   - **MESSAGE CONTENT INTENT**
4. Save.

Without both intents the bot connects but never sees the messages.

## 2. Check the bot's server permissions

In the NIGHTRAID server, the bot's role needs:

- **Manage Nicknames**
- **View Channel**, **Read Message History**, and **Add Reactions** in the nickname channel

Discord's role hierarchy still applies: drag the bot's role **above** the member roles it should rename. The server owner can never be renamed by a bot — the bot marks those messages with ⚠️.

## 3. Configure the environment

The bot reads:

| Variable | Required | Value |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | Yes | Already configured for the rest of the system. |
| `DISCORD_NICKNAME_CHANNEL_ID` | Yes | The nickname channel's ID. |
| `DISCORD_GUILD_ID` | No | When set, the bot ignores every other server. |

To copy the channel ID: Discord **User Settings → Advanced → Developer Mode**, then right-click the nickname channel → **Copy Channel ID**.

Put `DISCORD_NICKNAME_CHANNEL_ID` in `.env.local` (next to the existing variables) or set it on the host that runs the bot.

## 4. Run the bot

```
npm run bot:nickname
```

The script loads `.env.local` / `.env` automatically when present. A successful start logs:

```
Nickname bot connected as NIGHTRAID#0000. Watching channel 123456789012345678.
```

Keep the process running (pm2, systemd, a Railway/Render worker, or a terminal that stays open). If it is offline, messages in the nickname channel are simply not processed — nothing else in the system depends on it.

## 5. Test

1. Send an in-game name in the nickname channel from a normal member account.
2. The member's nickname changes to `NIGHT • <name>` and the message receives ✅.
3. Send the same name again — the bot answers with ✅ immediately without changing anything.
4. Send a message as someone the bot cannot manage (for example the server owner) — the message receives ⚠️.
