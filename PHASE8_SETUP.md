# NIGHTRAID Phase 8 — Discord bot

Phase 8 adds a Discord bot process that manages nickname requests and the server's rules commands.

## Nickname channel

The bot watches the nickname channel. When a member sends a message there, the bot checks it against the channel's name format, renames them, and marks the message:

- Member sends `NIGHT • Yepo` → their server nickname becomes `NIGHT • Yepo`.
- The bot reacts with ✅ on the message once the rename is done (or if the nickname already matches), so everyone can see who has been renamed already.
- The bot reacts with ❌ when the message does not follow the name format. Nobody is renamed.
- The bot reacts with ⚠️ when it cannot rename the member (the server owner, or someone with a role above the bot).

## The name format

The format posted in the channel is enforced by the bot (`bot/name-format.js`):

| Who | Format | Example |
| --- | --- | --- |
| NIGHTRAID members | `NIGHT • Name` | `NIGHT • Ems` |
| Other clan members | `TAG • NAME \| GAME` | `MRG • MIMAI \| BS` |
| Handlers and reps | `TAG • NAME - GAME HANDLER/REP` | `SS • KULIT - BS HANDLER/REP` |

- The clan tag is uppercased automatically, spacing around `•`, `|`, and `-` is normalised, and bullet look-alikes (`·`, `∙`, `●`) are accepted as `•` — small typing differences are corrected instead of rejected.
- Everyone outside NIGHTRAID must state a game (`| BS`) or a role (`- BS HANDLER`, `- REP`, `- BS HANDLER/REP`). `MRG • MIMAI` alone gets ❌.
- A NIGHTRAID name carries no game: `NIGHT • Ems | BS` gets ❌.
- The game code is up to 8 letters or digits, so use the short code (`BS`, `FL`, `ML`), not the full game name.
- The finished nickname must fit Discord's 32-character limit; anything longer gets ❌ instead of being silently cut.
- Plain chatter in the channel (`hi guys`) has no `•`, so it gets ❌ and changes nothing.

The reason for every ❌ is written to the bot's log, so check the host's console when a rejection is unclear.

## Renaming someone else (single or bulk)

Mentioning a member renames **them** instead of the sender. Each mention is paired with the name written next to it, so one message can rename several people:

- `NIGHT • ego @yepo` (or `@yepo NIGHT • ego`) sets @yepo's nickname to `NIGHT • ego`.
- `NIGHT • ego @yepo NIGHT • ems @maloi` renames @yepo **and** @maloi in one message.
- Every name in the message is checked against the format before anyone is renamed: if one of them is wrong, or a mention has no name next to it, the message gets ❌ and **nobody** is renamed. Fix the message and send it again.
- ✅ appears only when every mentioned member was renamed; if the bot is not allowed to rename one of them, the message gets ⚠️ and the rest are still renamed.
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
| `SCRIM_REGISTRATION_OPENER_IDS` | No | Extra Discord user IDs allowed to open a scrim cycle with a GIF, separated by commas. EMS is already allowed. |
| `DISCORD_APPLICATIONS_CHANNEL_ID` | Yes in Vercel; optional on bot host | The private channel where new application cards and decision buttons are posted. |
| `APP_URL` | No | Production website URL; defaults to `https://nightraidbg.com` on the bot host. |
| `ADMIN_DISCORD_IDS` | Yes in Vercel; optional on bot host | The two authorized administrator Discord IDs, separated by commas. Vercel always enforces this list. |

To copy an ID: Discord **User Settings → Advanced → Developer Mode**, then right-click the server or channel → **Copy ID**.

Put the nickname channel ID in `.env.local` (next to the existing variables) and on the host that runs the bot. Set `DISCORD_RULES_CHANNEL_ID` only if the official rules move to another channel.

## Discord application review channel

Create a private text channel such as `application-review`. Only the two NIGHTRAID administrators and the NIGHTRAID bot should be able to view it. Give the bot **View Channel**, **Send Messages**, **Read Message History**, and **Use Application Commands** in that channel.

Copy the channel ID and configure these values in **Vercel**:

```text
DISCORD_APPLICATIONS_CHANNEL_ID=123456789012345678
ADMIN_DISCORD_IDS=<first-admin-id>,<second-admin-id>
```

The bot host does not need a new secret. It signs decision requests with its existing `DISCORD_BOT_TOKEN`; Vercel verifies the signature, channel ID, and administrator ID. `DISCORD_APPLICATIONS_CHANNEL_ID`, `ADMIN_DISCORD_IDS`, and `APP_URL` may also be placed on the bot host for earlier local validation, but they are not required there.

Deploy the website API first, update the bot to the same Git commit, then restart the long-lived Discord bot. Its startup logs must include `Discord application review interactions enabled.` Every new application will post a plain Discord Markdown review message in that channel:

- **ACCEPT** runs the existing approval workflow, including Discord onboarding, applicant DM, nickname and game roles, Excel, and Google Sheets.
- **REJECT** opens a required reason form, records the rejection, and sends that reason to the applicant through Discord. If the applicant is not in the server, the system uses the applicant's authorized `guilds.join` access to add them temporarily, deliver the DM, and remove them again without assigning member roles.
- **VIEW FULL FORM** opens the protected web admin portal.
- Only Discord accounts listed in Vercel's `ADMIN_DISCORD_IDS` can use the decision buttons. The bot signs each request with its bot token, and the website verifies it before changing an application.

Discord can still refuse a DM when the applicant has blocked the bot, disabled applicable DMs, revoked the app authorization, or allowed the OAuth token to expire without a refresh token. Those platform-level refusals cannot be bypassed; the recorded decision remains available in the application status portal.

## Rules commands

When the bot starts, it registers the rules commands as instant guild commands in `DISCORD_GUILD_ID`. Members can run them in any channel where **Use Application Commands** is allowed, including the text chat attached to a voice channel.

| Command | Response | Source |
| --- | --- | --- |
| `/rules` | **NIGHTRAID RULES** | Pinned messages in `DISCORD_RULES_CHANNEL_ID`, or the latest 100 messages when nothing is pinned |
| `/nrules` | **NIGHTRAID CLAN RULES** | Message `1443300854613544993` |
| `/scrimrules` | **SCRIM MECHANICS** plus its official image | Text message `1522987468532744332` and image message `1522987523335524442` |

Discord requires lowercase slash-command names, so the NIGHTRAID clan command is `/nrules`, not `/Nrules`. Every response uses plain Discord Markdown rather than embeds. Long fetched rules are split into ordered continuation messages, and the final message contains Markdown links back to the source and any official image.

For predictable results, pin only the official rule messages and arrange the rules in the order they were originally posted. The bot needs **View Channel** and **Read Message History** in the rules channel. Keep **MESSAGE CONTENT INTENT** enabled so it can read the rule text.

## Server-link trigger

In any NIGHTRAID server channel the bot can read, a message containing the whole word `link` (case-insensitive) receives a direct plain-Markdown reply with the permanent invite:

```text
https://discord.gg/ufwJ7wWu9H
```

Words such as `linked` or `linking` do not activate the trigger. Link-trigger messages in the nickname, registration, or cancellation channels bypass those channels' normal validation.

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

One message may contain several valid lines. Every new cycle starts with `APXS - APEX SYNDICATE` reserved in `01A`; normal registrations fill the remaining slots from `02B` through `25Y`, then enter the waiting list in order. APXS can still cancel its reserved slot through the normal cancellation flow. Posting a new registration banner GIF closes the previous cycle and starts a fresh real-time board.

Registration remains closed until EMS posts the official registration GIF in the team-registration channel. That GIF is the opening signal: the bot leaves the previous slot-list message unchanged as history, posts the banner GIF first in the registered-teams channel, follows it with a plain-text slot-list message and a plain-text waiting-list message, starts a new cycle at the opening GIF's timestamp, and logs only team messages sent after it. Random GIFs from applicants do not restart the board. Additional trusted opener IDs can be added as a comma-separated `SCRIM_REGISTRATION_OPENER_IDS` environment variable.

The bot validates the entire message before adding anything:

- Every non-empty line must follow `FLAG | TAG - TEAM NAME`.
- A fully valid message receives ✅ only after the live board is updated.
- An invalid message receives ❌ and none of its teams are registered.
- A duplicate-only message receives ❌ because it did not add a new team.
- Editing a registration rebuilds the live board with the corrected tag or team name.
- Deleting a registration removes every team submitted by that message and promotes the waiting list as needed.

### Cancellation and MINE-only slots

Use this format in the cancellation channel:

```text
CANCEL - TEAM NAME
```

The team is removed. If it owned a slot, that slot stays empty and is locked for a `MINE` reply. The waiting list is not promoted, and later registrations skip the locked slot.

An administrator can open one or several numbered slots directly:

```text
AVAILABLE SLOT 1
AVAILABLE SLOT 1, 2, 3 & 4
```

The current teams in those slots are removed. The listed slots remain locked for `MINE` replies in the same order, without promoting the waiting list.

### Claiming a canceled slot

Reply directly to the `CANCEL - TEAM NAME` message:

```text
MINE - TEAM TAG TEAM NAME
```

The claiming team receives the first still-open slot created by the referenced cancellation or `AVAILABLE SLOT` message. A team claiming from the waiting list is removed from that list. For a multi-slot `AVAILABLE SLOT` message, valid replies fill its slots in the order listed.

Editing a valid `MINE` reply rebuilds its claimed slot with the corrected team. Deleting the `MINE` reply removes that claim when the team came from the reply, then rebuilds the remaining slots and waiting list.

The live board is bot-owned, unpinned, rendered as normal Discord text instead of embeds, automatically edited after each change, and reconstructed after restarts. A standalone banner GIF is posted immediately before every new board. Its Philippine date is refreshed automatically. The bot needs **View Channel**, **Read Message History**, **Send Messages**, **Embed Links**, **Add Reactions**, and **Manage Messages** in the three channels.

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

1. Send `NIGHT • Testname` in the nickname channel from a normal member account.
2. The member's nickname changes to `NIGHT • Testname` and the message receives ✅.
3. Send the same name again — the bot answers with ✅ immediately without changing anything.
4. Send `Testname` and then `MRG • MIMAI` — both receive ❌ and no nickname changes.
5. Send `MRG • MIMAI | BS` and `SS • KULIT - BS HANDLER/REP` — both receive ✅.
6. Send a message as someone the bot cannot manage (for example the server owner) — the message receives ⚠️.
7. Type `/rules` in a normal text channel and confirm the plain Markdown rules messages appear.
8. Join a voice channel, open that voice channel's text chat, type `/rules`, and confirm the same plain Markdown messages appear.
9. Run `/nrules` and confirm **NIGHTRAID CLAN RULES** uses the configured clan-rules message.
10. Run `/scrimrules` and confirm **SCRIM MECHANICS** includes both the mechanics text and requested image.
11. Send `link`, `LINK`, and `Can I get the link please?` and confirm each receives the permanent NIGHTRAID invite without an embed preview.
12. Send two valid teams in one registration message and confirm both appear in consecutive slots.
13. Fill the slots, register a waiting team, cancel a slotted team, and confirm the waiting list is not promoted.
14. Reply `MINE - TAG TEAM NAME` to a cancellation and confirm the claimed team takes the canceled slot.
