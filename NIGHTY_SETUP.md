# Nighty Discord Game

Nighty is NIGHTRAID's original persistent collecting and economy game. It uses ordinary Discord messages instead of slash commands.

## Production setup

1. Apply [`database/phase19.sql`](database/phase19.sql) in the existing Supabase project's SQL editor.
2. Apply [`database/phase20.sql`](database/phase20.sql) after Phase 19.
3. Apply [`database/phase21.sql`](database/phase21.sql) after Phase 20.
4. Apply [`database/phase22.sql`](database/phase22.sql) after Phase 21.
5. Keep `SUPABASE_URL` and `SUPABASE_SECRET_KEY` configured for the Discord bot.
6. Optionally set `NIGHTY_TIME_ZONE` (defaults to `Asia/Manila`).
7. Optionally set `NIGHTY_ADMIN_ROLE_IDS` to comma-separated Discord role IDs.
8. Deploy or restart `npm run bot:nickname`.

The migrations enable row-level security, restrict all Nighty tables and economy functions to the Supabase service role, and record currency changes in `nighty_ledger`. Phase 20 adds atomic combat wagers, trades, and market escrow. Phase 21 adds duplicate-safe game settlement, cooldowns, statistics, and escrowed interactive sessions. Phase 22 adds protected economy administration and audit history.

## Phase 1 commands

Both `night` and `nighty` work as prefixes.

- `nighty help`
- `nighty profile`
- `nighty balance`
- `night cash`
- `nighty daily`
- `nighty missions`
- `nighty claim <mission_id>`
- `nighty claim all`
- `nighty hunt`
- `nighty collection`
- `nighty inventory`
- `nighty zoo`

The first player record receives exactly **1,000,000 Night Currency**. Daily rewards use a seven-day streak, missions have separate daily and weekly periods, and hunts have a 15-second cooldown.

## Phase 2 commands

- `nighty battle`
- `nighty pvp @player <wager>`
- `nighty trade @player <character_id> <quantity> <total_price>`
- `nighty market`
- `nighty market sell <character_id> <quantity> <total_price>`
- `nighty market cancel <listing_id>`
- `nighty buy <listing_id>`

PvP challenges expire after two minutes and only the challenged player can accept them. The selected wager is checked again when they accept. Private trades work the same way and expire after ten minutes. Market listings escrow the seller's characters until another player buys the listing or the seller cancels it. Amounts may be entered as `100000`, `100,000`, `100k`, or `1m`.

## Phase 3 commands

- `nighty slots <bet>`
- `nighty coinflip <heads|tails> <bet>`
- `nighty blackjack <bet>`
- `nighty trivia`
- `nighty fish`
- `nighty dungeon`
- `nighty boss`
- `nighty word`
- `nighty word <answer>`
- `nighty stats`

Casino bets must be between **1,000** and **1,000,000 Night Currency**. Blackjack wagers are escrowed when the hand starts and its Hit/Stand buttons expire after three minutes. Trivia answer buttons expire after 45 seconds. Word scrambles expire after 90 seconds. Fishing, dungeon raids, and boss fights use separate cooldowns, and dungeon/boss power comes from the player's strongest owned NIGHTRAID character.

Every completed game advances the `daily_games` and `weekly_games` missions. Positive net winnings also advance the weekly currency mission. Replayed Discord messages and repeated button presses cannot pay twice.

## Phase 4 commands

- `nighty games`
- `nighty leaderboard`
- `nighty admin help`
- `nighty admin grant @player <amount> [reason]`
- `nighty admin remove @player <amount> [reason]`
- `nighty admin set @player <amount> [reason]`
- `nighty admin reset-cooldowns @player [reason]`
- `nighty admin economy`
- `nighty admin audit [@player]`

Admin commands require Discord's **Manage Server** permission, Administrator, or a role listed in `NIGHTY_ADMIN_ROLE_IDS`. Targets must already have a Nighty profile. Removals cannot make a balance negative, and replaying the same Discord message cannot apply an adjustment twice.

Every successful administration action records the acting admin, target, operation, amount, before/after balances, reason, and Discord message ID in `nighty_admin_actions`. The table and its RPCs are restricted to the Supabase service role.

Slots were tuned so a two-symbol match returns 1.5× instead of 2×, keeping the long-term expected payout below 100%. Triple-symbol jackpots are unchanged.

## Artwork

- [`images/nighty/nighty-world.png`](images/nighty/nighty-world.png): original NIGHTRAID character-world banner.
- [`images/nighty/nighty-games.png`](images/nighty/nighty-games.png): original eight-game menu artwork used by `nighty games`.
