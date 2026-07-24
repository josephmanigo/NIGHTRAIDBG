# NIGHTRAID Phase 8 — Discord bot

Phase 8 adds a Discord bot process that manages nickname requests and the server's `/rules` command.

## Nickname channel

The bot watches the nickname channel. When a member sends a message there, the bot renames them to the message text and marks the message:

- Member sends `Yepo` → their server nickname becomes `Yepo`.
- The bot reacts with ✅ on the message once the rename is done (or if the nickname already matches), so everyone can see who has been renamed already.
- The bot reacts with ⚠️ when it cannot rename the member (the server owner, or someone with a role above the bot).

Nicknames are trimmed to Discord's 32-character limit.

## Renaming someone else (single or bulk)

Mentioning a member renames **them** instead of the sender. Each mention is paired with the name written next to it, so one message can rename several people:

- `ego @yepo` (or `@yepo ego`) sets @yepo's nickname to `ego`.
- `ego @yepo ems @maloi` sets @yepo to `ego` **and** @maloi to `ems` in one message.
- ✅ appears only when every mentioned member was renamed; if any of them could not be (or a mention had no name next to it), the message gets ⚠️ and the rest are still renamed.
- Anyone in the channel can rename themselves or mentioned members — there is no permission requirement. Restrict who can post in the nickname channel if that gets abused.
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
| `DISCORD_GUILD_ID` | Yes for `/rules` | The NIGHTRAID server ID. |
| `DISCORD_RULES_CHANNEL_ID` | No | Overrides the default NIGHTRAID rules channel (`1208605026868535387`). |

To copy an ID: Discord **User Settings → Advanced → Developer Mode**, then right-click the server or channel → **Copy ID**.

Put the nickname channel ID in `.env.local` (next to the existing variables) and on the host that runs the bot. Set `DISCORD_RULES_CHANNEL_ID` only if the official rules move to another channel.

## `/rules` command

When the bot starts, it registers `/rules` as an instant guild command in `DISCORD_GUILD_ID`. Members can run it in any channel where **Use Application Commands** is allowed, including the text chat attached to a voice channel.

The response is a NIGHTRAID-styled embed:

- Pinned messages in `DISCORD_RULES_CHANNEL_ID` are used first, ordered from oldest to newest.
- If nothing is pinned, the latest 100 messages are used.
- The response includes an **OPEN RULES CHANNEL** button.

For predictable results, pin only the official rule messages and arrange the rules in the order they were originally posted. The bot needs **View Channel** and **Read Message History** in the rules channel. Keep **MESSAGE CONTENT INTENT** enabled so it can read the rule text.

## 4. Run the bot

```
npm run bot:nickname
```

The script loads `.env.local` / `.env` automatically when present. A successful start logs:

```
Nickname bot connected as NIGHTRAID#0000. Watching channel 123456789012345678.
/rules is registered in NIGHTRAID. Rules source: 234567890123456789.
```

Keep the process running (pm2, systemd, a Railway/Render worker, or a terminal that stays open). If it is offline, messages in the nickname channel are simply not processed — nothing else in the system depends on it.

## 5. Test

1. Send an in-game name in the nickname channel from a normal member account.
2. The member's nickname changes to the message text and the message receives ✅.
3. Send the same name again — the bot answers with ✅ immediately without changing anything.
4. Send a message as someone the bot cannot manage (for example the server owner) — the message receives ⚠️.
5. Type `/rules` in a normal text channel and confirm the rules embed appears.
6. Join a voice channel, open that voice channel's text chat, type `/rules`, and confirm the same rules embed appears.
