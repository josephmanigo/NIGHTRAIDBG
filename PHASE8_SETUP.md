# NIGHTRAID Phase 8 — Discord bot

Phase 8 adds a Discord bot process that manages nickname requests and the server's rules commands.

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

## Rules commands

When the bot starts, it registers the rules commands as instant guild commands in `DISCORD_GUILD_ID`. Members can run them in any channel where **Use Application Commands** is allowed, including the text chat attached to a voice channel.

| Command | Response | Source |
| --- | --- | --- |
| `/rules` | **NIGHTRAID RULES** | Pinned messages in `DISCORD_RULES_CHANNEL_ID`, or the latest 100 messages when nothing is pinned |
| `/nrules` | **NIGHTRAID CLAN RULES** | Message `1443300854613544993` |
| `/scrimrules` | **SCRIM MECHANICS** plus its official image | Text message `1522987468532744332` and image message `1522987523335524442` |

Discord requires lowercase slash-command names, so the NIGHTRAID clan command is `/nrules`, not `/Nrules`. Every response uses a NIGHTRAID-styled embed and includes a button linking back to its source message or channel.

For predictable results, pin only the official rule messages and arrange the rules in the order they were originally posted. The bot needs **View Channel** and **Read Message History** in the rules channel. Keep **MESSAGE CONTENT INTENT** enabled so it can read the rule text.

## Scrim registration automation

The same long-running bot maintains a live ordered scrim board across these channels:

| Purpose | Channel ID |
| --- | --- |
| Team registration | `1260139820836065300` |
| Live registered teams and waiting list | `1260501981508669471` |
| Cancellations and replacement claims | `1344620122094174281` |

### Registration

Each valid line in the registration channel is added in message order:

```text
🇵🇭 | TAG - TEAM NAME
```

One message may contain several valid lines. Slots are filled from `01A` through `25Y`; additional teams enter the waiting list in order. Posting a new registration banner GIF clears the previous cycle and starts a fresh real-time board.

The bot validates the entire message before adding anything:

- Every non-empty line must follow `FLAG | TAG - TEAM NAME`.
- A fully valid message receives ✅ only after the live board is updated.
- An invalid message receives ❌ and none of its teams are registered.
- A duplicate-only message receives ❌ because it did not add a new team.
- Editing a registration rebuilds the live board with the corrected tag or team name.
- Deleting a registration removes every team submitted by that message and promotes the waiting list as needed.

### Cancellation and waiting-list promotion

Use this format in the cancellation channel:

```text
CANCEL - TEAM NAME
```

The team is removed. If it owned a slot, the first waiting-list team is immediately promoted into that exact slot.

### Claiming a canceled slot

Reply directly to the `CANCEL - TEAM NAME` message:

```text
MINE - TEAM TAG TEAM NAME
```

The claiming team receives the canceled slot. If a waiting-list team was temporarily promoted, it returns to the front of the waiting list. Only the first valid claim is accepted.

Editing a valid `MINE` reply rebuilds its claimed slot with the corrected team. Deleting the `MINE` reply removes that claim when the team came from the reply, then rebuilds the remaining slots and waiting list.

The live board is bot-owned, pinned, automatically edited after each change, and reconstructed after restarts. Its Philippine date is refreshed automatically. The bot needs **View Channel**, **Read Message History**, **Send Messages**, **Embed Links**, **Add Reactions**, and **Manage Messages** in the three channels.

Run only one long-lived bot instance with a given Discord bot token. Starting the same bot locally while a hosted worker is active makes Discord deliver each registration and cancellation to both processes, which causes duplicate replies.

## 4. Run the bot

```
npm run bot:nickname
```

The script loads `.env.local` / `.env` automatically when present. A successful start logs:

```
Nickname bot connected as NIGHTRAID#0000. Watching channel 123456789012345678.
/rules, /nrules, /scrimrules registered in NIGHTRAID.
```

Keep the process running (pm2, systemd, a Railway/Render worker, or a terminal that stays open). If it is offline, messages in the nickname channel are simply not processed — nothing else in the system depends on it.

## 5. Test

1. Send an in-game name in the nickname channel from a normal member account.
2. The member's nickname changes to the message text and the message receives ✅.
3. Send the same name again — the bot answers with ✅ immediately without changing anything.
4. Send a message as someone the bot cannot manage (for example the server owner) — the message receives ⚠️.
5. Type `/rules` in a normal text channel and confirm the rules embed appears.
6. Join a voice channel, open that voice channel's text chat, type `/rules`, and confirm the same rules embed appears.
7. Run `/nrules` and confirm **NIGHTRAID CLAN RULES** uses the configured clan-rules message.
8. Run `/scrimrules` and confirm **SCRIM MECHANICS** includes both the mechanics text and requested image.
9. Send two valid teams in one registration message and confirm both appear in consecutive slots.
10. Fill the slots, register a waiting team, cancel a slotted team, and confirm the first waiting team is promoted.
11. Reply `MINE - TAG TEAM NAME` to a cancellation and confirm the claimed team replaces the canceled slot.
