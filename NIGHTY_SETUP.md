# Nighty Discord Game

Nighty is NIGHTRAID's original persistent collecting and economy game. It uses ordinary Discord messages instead of slash commands.

## Production setup

1. Apply [`database/phase19.sql`](database/phase19.sql) in the existing Supabase project's SQL editor.
2. Apply [`database/phase20.sql`](database/phase20.sql) after Phase 19.
3. Apply [`database/phase21.sql`](database/phase21.sql) after Phase 20.
4. Apply [`database/phase22.sql`](database/phase22.sql) after Phase 21.
5. Apply [`database/phase23.sql`](database/phase23.sql) after Phase 22.
6. Apply [`database/phase24.sql`](database/phase24.sql) after Phase 23.
7. Keep `SUPABASE_URL` and `SUPABASE_SECRET_KEY` configured for the Discord bot.
8. Optionally set `NIGHTY_TIME_ZONE` (defaults to `Asia/Manila`).
9. Optionally set `NIGHTY_ADMIN_ROLE_IDS` to comma-separated Discord role IDs.
10. Deploy or restart `npm run bot:nickname`.

The migrations enable row-level security, restrict all Nighty tables and economy functions to the Supabase service role, and record currency changes in `nighty_ledger`. Phase 20 adds atomic combat wagers, trades, and market escrow. Phase 21 adds duplicate-safe game settlement, cooldowns, statistics, and escrowed interactive sessions. Phase 22 adds protected economy administration and audit history. Phase 23 enables explicit all-in wagers for existing installations. Phase 24 adds persistent multiplayer lobbies, per-player escrow, replay-safe party settlement, and expired-session refunds.

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
- `nighty duel @player <wager|all> [character_id]`
- `nighty trade @player <character_id> <quantity> <total_price>`
- `nighty market`
- `nighty market sell <character_id> <quantity> <total_price>`
- `nighty market cancel <listing_id>`
- `nighty buy <listing_id>`

Shadow Duel challenges expire after two minutes and only the challenged player can accept them. The challenger can provide an owned character ID or use their strongest fighter automatically; the opponent chooses from their four strongest characters. Both secretly select Attack, Defend, or a one-use Skill for up to five rounds. Private trades expire after ten minutes. Market listings escrow the seller's characters until another player buys the listing or the seller cancels it. Amounts may be entered as `100000`, `100,000`, `100k`, or `1m`.

## Phase 3 commands

- `nighty sl <bet|all>` — slots
- `nighty cf <heads|tails> <bet|all>` — coin flip
- `nighty bj <bet|all>` — blackjack
- `nighty tr` — trivia
- `nighty f` — fishing
- `nighty dg` — dungeon
- `nighty bf` — boss fight
- `nighty wg` — word scramble
- `nighty wg <answer>` — answer a word scramble
- `nighty stats`

The full command names still work. Numeric casino bets must be between **1,000** and **1,000,000 Night Currency**. Use `all` to wager the player's complete current balance, such as `nighty bj all`, `nighty sl all`, or `nighty cf heads all`. PvP also accepts `nighty pvp @player all`. Blackjack displays Unicode card faces, keeps the dealer's second card hidden until resolution, and retains Hit/Stand buttons while the hand is active. Wagers are escrowed when the hand starts and expire after three minutes. Trivia answer buttons expire after 45 seconds. Word scrambles expire after 90 seconds. Fishing, dungeon raids, and boss fights use separate cooldowns, and dungeon/boss power comes from the player's strongest owned NIGHTRAID character.

Every completed game advances the `daily_games` and `weekly_games` missions. Positive net winnings also advance the weekly currency mission. Replayed Discord messages and repeated button presses cannot pay twice.

## Interactive game commands

- `nighty mines <bet|all> [1-10 mines]` — 4×4 Abyss Mines board with tile and Cash Out buttons
- `nighty crash <bet|all>` or `nighty cr <bet|all>` — shared Nightfall Crash lobby for up to ten players
- `nighty bj table <bet|all>` or `nighty mbj <bet|all>` — multiplayer Blackjack for up to four players

Nightfall Crash uses a shared Push Multiplier button: any player still riding can increase the multiplier while each player decides when to cash out. Multiplayer Blackjack displays the dealer and every player hand in one updating message and supports Hit, Stand, Double, and Split. All-in wagers show a Confirm/Cancel screen before play. Party sessions lock each wager separately, reject duplicate actions, and refund unsettled wagers when cancelled or expired.

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
