/*
 * Nighty is NIGHTRAID's persistent text-command economy and collection game.
 * Both `night ...` and `nighty ...` are accepted; it intentionally does not
 * register slash commands.
 */
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Events,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js'
import {
  NIGHTY_BATTLE_COOLDOWN_SECONDS,
  NIGHTY_CHARACTER_BY_ID,
  NIGHTY_CHARACTERS,
  NIGHTY_HUNT_COOLDOWN_SECONDS,
  NIGHTY_MISSIONS,
  NIGHTY_MISSION_BY_ID,
  NIGHTY_PVP_EXPIRY_SECONDS,
  NIGHTY_TIME_ZONE,
  NIGHTY_TRADE_EXPIRY_SECONDS,
  formatNightCurrency,
  nightyPeriodKeys,
  parseNightAmount,
  resolveNightyBattle,
  selectNightyCharacter,
} from './nighty-data.js'
import { createSupabaseNightyStore } from './nighty-store.js'
import {
  NIGHTY_BLACKJACK_EXPIRY_SECONDS,
  NIGHTY_BOSSES,
  NIGHTY_BOSS_COOLDOWN_SECONDS,
  NIGHTY_DUNGEONS,
  NIGHTY_DUNGEON_COOLDOWN_SECONDS,
  NIGHTY_FISHING_COOLDOWN_SECONDS,
  NIGHTY_MAX_BET,
  NIGHTY_MIN_BET,
  NIGHTY_TRIVIA_EXPIRY_SECONDS,
  NIGHTY_TRIVIA_REWARD,
  NIGHTY_WORD_EXPIRY_SECONDS,
  NIGHTY_WORD_REWARD,
  blackjackHandValue,
  blackjackPayout,
  catchNightyFish,
  createBlackjackState,
  createNightyWord,
  finishBlackjack,
  flipNightyCoin,
  hitBlackjack,
  resolveNightyAdventure,
  selectNightyTrivia,
  spinNightySlots,
  validNightyBet,
} from './nighty-games.js'
import {
  NIGHTY_MAX_MINES,
  NIGHTY_MIN_MINES,
  NIGHTY_MINES_CELLS,
  NIGHTY_PARTY_EXPIRY_SECONDS,
  advanceNightyCrash,
  cashOutNightyCrash,
  chooseShadowAction,
  createNightyCrashState,
  createNightyMinesState,
  createShadowDuelState,
  createShadowFighter,
  finishPartyBlackjack,
  nightyCrashMultiplier,
  nightyMinesMultiplier,
  nightyMinesPayout,
  partyBlackjackActionCost,
  pickNightyMine,
  playPartyBlackjack,
  startNightyCrash,
  startPartyBlackjack,
} from './nighty-interactive-games.js'

const NIGHTY_COLOR = 0x7C3AED
const NIGHTY_ART_PATH = fileURLToPath(new URL('../images/nighty/nighty-world.png', import.meta.url))
const NIGHTY_ART_NAME = 'nighty-world.png'
const NIGHTY_GAMES_ART_PATH = fileURLToPath(new URL('../images/nighty/nighty-games.png', import.meta.url))
const NIGHTY_GAMES_ART_NAME = 'nighty-games.png'
const COMMAND_PATTERN = /^night(y)?(?:\s+(.+))?$/i
const COMMAND_ALIASES = Object.freeze({
  bal: 'balance',
  cash: 'balance',
  wallet: 'balance',
  inv: 'collection',
  inventory: 'collection',
  zoo: 'collection',
  character: 'collection',
  characters: 'collection',
  mission: 'missions',
  start: 'profile',
  me: 'profile',
  fight: 'battle',
  duel: 'pvp',
  sell: 'market_sell',
  sl: 'slots',
  slot: 'slots',
  cf: 'coinflip',
  coin: 'coinflip',
  flip: 'coinflip',
  bj: 'blackjack',
  mbj: 'blackjack_multi',
  mines: 'mines',
  mine: 'mines',
  cr: 'crash',
  tr: 'trivia',
  quiz: 'trivia',
  f: 'fish',
  fishing: 'fish',
  dg: 'dungeon',
  raid: 'dungeon',
  dungeons: 'dungeon',
  bf: 'boss',
  bossfight: 'boss',
  wg: 'word',
  words: 'word',
  games: 'game_help',
})

const BUTTON_PATTERN = /^nighty:(pvp|trade):(accept|decline):([a-f0-9-]{8,64})$/i
const GAME_BUTTON_PATTERN = /^nighty:(blackjack|trivia):(hit|stand|answer_[0-3]):([a-f0-9-]{8,64})$/i
const PARTY_BUTTON_PATTERN = /^nighty:(duel|mines|crash|blackjack_multi):([a-z0-9_]{1,48}):([a-f0-9-]{8,64})$/i

export function parseNightyCommand(content) {
  const match = String(content || '').trim().match(COMMAND_PATTERN)
  if (!match) return null
  const tokens = String(match[2] || '').trim().split(/\s+/).filter(Boolean)
  const rawCommand = (tokens.shift() || 'help').toLowerCase()
  return {
    prefix: match[1] ? 'nighty' : 'night',
    command: COMMAND_ALIASES[rawCommand] || rawCommand,
    args: tokens,
  }
}

export function parseNightyButtonId(customId) {
  const match = String(customId || '').match(BUTTON_PATTERN)
  return match ? {
    type: match[1].toLowerCase(),
    action: match[2].toLowerCase(),
    id: match[3].toLowerCase(),
  } : null
}

export function parseNightyGameButtonId(customId) {
  const match = String(customId || '').match(GAME_BUTTON_PATTERN)
  return match ? {
    gameType: match[1].toLowerCase(),
    action: match[2].toLowerCase(),
    id: match[3].toLowerCase(),
  } : null
}

export function parseNightyPartyButtonId(customId) {
  const match = String(customId || '').match(PARTY_BUTTON_PATTERN)
  return match ? {
    gameType: match[1].toLowerCase(),
    action: match[2].toLowerCase(),
    id: match[3].toLowerCase(),
  } : null
}

function mentionedUserId(value) {
  return String(value || '').match(/^<@!?(\d{16,22})>$/)?.[1] || null
}

function positiveQuantity(value) {
  const quantity = Number(value)
  return Number.isSafeInteger(quantity) && quantity > 0 ? quantity : null
}

function parseAdminAmount(value, allowZero = false) {
  const normalized = String(value || '').trim().replace(/,/g, '')
  if (allowZero && /^0+$/.test(normalized)) return 0
  return parseNightAmount(value)
}

function parseNightyWager(value, balance) {
  if (String(value || '').trim().toLowerCase() === 'all') {
    const amount = Math.trunc(Number(balance))
    return Number.isSafeInteger(amount) && amount > 0 ? { amount, allIn: true } : null
  }
  const amount = parseNightAmount(value)
  return amount ? { amount, allIn: false } : null
}

function validCasinoWager(wager) {
  return Boolean(wager && (wager.allIn ? wager.amount >= NIGHTY_MIN_BET : validNightyBet(wager.amount)))
}

function withArt(embed) {
  embed.setImage(`attachment://${NIGHTY_ART_NAME}`)
  return {
    embeds: [embed],
    files: [{ attachment: NIGHTY_ART_PATH, name: NIGHTY_ART_NAME }],
  }
}

function withGamesArt(embed) {
  embed.setImage(`attachment://${NIGHTY_GAMES_ART_NAME}`)
  return {
    embeds: [embed],
    files: [{ attachment: NIGHTY_GAMES_ART_PATH, name: NIGHTY_GAMES_ART_NAME }],
  }
}

function hasNightyAdminPermission(message, adminRoleIds) {
  if (message.member?.permissions?.has?.(PermissionFlagsBits.ManageGuild)) return true
  return adminRoleIds.some((roleId) => message.member?.roles?.cache?.has?.(roleId))
}

function baseEmbed(title, description = null) {
  const embed = new EmbedBuilder().setColor(NIGHTY_COLOR).setTitle(title)
  if (description) embed.setDescription(description)
  return embed.setFooter({ text: 'NIGHTY · NIGHTRAID' })
}

function welcomeText(isNew) {
  return isNew ? '\n\nNew player grant: **1,000,000 Night Currency**.' : ''
}

function missionPeriodKey(mission, periods) {
  return mission.periodType === 'daily' ? periods.dailyKey : periods.weeklyKey
}

function missionSnapshot(mission, periods, progressRows) {
  const periodKey = missionPeriodKey(mission, periods)
  const row = progressRows.find((item) =>
    item.missionId === mission.id
    && item.periodType === mission.periodType
    && item.periodKey === periodKey)
  const progress = Math.min(mission.goal, row?.progress || 0)
  return {
    ...mission,
    periodKey,
    progress,
    claimed: Boolean(row?.claimedAt),
    complete: progress >= mission.goal,
  }
}

function helpPayload() {
  const embed = baseEmbed(
    'Nighty',
    'NIGHTRAID’s persistent collecting and economy game. Use either `night` or `nighty`—no slash command is required.',
  ).addFields(
    { name: 'Economy', value: '`nighty balance` · `night cash` · `nighty daily`' },
    { name: 'Adventure', value: '`nighty hunt` · `nighty battle` · `nighty collection` · `nighty profile`' },
    { name: 'PvP', value: '`nighty duel @player <wager> [character_id]` · interactive Shadow Duel' },
    { name: 'Trading', value: '`nighty trade @player <character_id> <quantity> <total_price>`' },
    { name: 'Market', value: '`nighty market` · `nighty market sell <character_id> <quantity> <price>` · `nighty buy <listing_id>`' },
    { name: 'Missions', value: '`nighty missions` · `nighty claim <mission_id>` · `nighty claim all`' },
    { name: 'Casino', value: '`nighty sl <bet>` · `nighty cf <heads|tails> <bet>` · `nighty bj <bet>` · `nighty mines <bet> [mines]` · `nighty crash <bet>`' },
    { name: 'Multiplayer table', value: '`nighty bj table <bet>` · up to four players with Hit, Stand, Double, and Split' },
    { name: 'Quick games', value: '`nighty tr` · `nighty f` · `nighty wg` · `nighty wg <answer>`' },
    { name: 'Raids', value: '`nighty dg` · `nighty bf`' },
    { name: 'Game records', value: '`nighty stats` · bets accept `100k`, `1m`, or `all`' },
    { name: 'Rankings', value: '`nighty leaderboard` · `nighty games`' },
  )
  return withArt(embed)
}

function gameHelpPayload() {
  const embed = baseEmbed('Nighty Games', 'Eight persistent games plus interactive PvP and party tables share your Night Currency balance, missions, records, escrow, and duplicate-safe settlement.')
    .addFields(
      { name: 'Casino', value: '`nighty sl <bet>` (slots)\n`nighty cf <heads|tails> <bet>` (coin flip)\n`nighty bj <bet>` (blackjack)' },
      { name: 'Interactive casino', value: '`nighty mines <bet> [1-10 mines]`\n`nighty crash <bet>` (shared lobby)\n`nighty bj table <bet>` (up to four players)' },
      { name: 'Interactive PvP', value: '`nighty duel @player <bet> [character_id]`\nBoth players secretly choose Attack, Defend, or Skill.' },
      { name: 'Knowledge & collection', value: '`nighty tr` (trivia)\n`nighty wg` then `nighty wg <answer>` (word)\n`nighty f` (fishing)' },
      { name: 'Raids', value: '`nighty dg` (dungeon)\n`nighty bf` (boss)\nBoth use your strongest owned character.' },
      { name: 'Limits', value: `Numeric casino bets: ${formatNightCurrency(NIGHTY_MIN_BET)}–${formatNightCurrency(NIGHTY_MAX_BET)}. Use \`all\` to wager your full balance.` },
    )
  return withGamesArt(embed)
}

function balancePayload(player, isNew) {
  return {
    embeds: [baseEmbed('Nighty Balance')
      .setDescription(`<@${player.userId}> has **${formatNightCurrency(player.balance)}**.${welcomeText(isNew)}`)],
  }
}

function profilePayload(player, collection, isNew) {
  const uniqueCharacters = collection.length
  const totalCharacters = collection.reduce((sum, item) => sum + item.quantity, 0)
  const embed = baseEmbed('Nighty Profile', `<@${player.userId}>${welcomeText(isNew)}`)
    .addFields(
      { name: 'Night Currency', value: formatNightCurrency(player.balance), inline: true },
      { name: 'Daily streak', value: `${player.dailyStreak} day${player.dailyStreak === 1 ? '' : 's'}`, inline: true },
      { name: 'Hunts', value: String(player.totalHunts), inline: true },
      { name: 'PvE record', value: `${player.totalBattleWins} wins / ${player.totalBattles} battles`, inline: true },
      { name: 'Collection', value: `${uniqueCharacters}/${NIGHTY_CHARACTERS.length} unique · ${totalCharacters} total`, inline: false },
    )
  return withArt(embed)
}

function collectionPayload(player, collection) {
  const byId = new Map(NIGHTY_CHARACTERS.map((character) => [character.id, character]))
  const lines = collection.map((item) => {
    const character = byId.get(item.characterId)
    return character
      ? `**${character.name}** · \`${character.id}\` · ${character.rarity} · x${item.quantity}`
      : `**${item.characterId}** · x${item.quantity}`
  })
  const description = lines.length > 0
    ? lines.join('\n')
    : 'Your collection is empty. Use `nighty hunt` to recruit your first character.'
  return {
    embeds: [baseEmbed(`${player.userId ? 'Nighty Collection' : 'Collection'}`, description)
      .addFields({ name: 'Collected', value: `${collection.length}/${NIGHTY_CHARACTERS.length} unique characters` })],
  }
}

function missionsPayload(periods, progressRows) {
  const snapshots = NIGHTY_MISSIONS.map((mission) => missionSnapshot(mission, periods, progressRows))
  const embed = baseEmbed(
    'Nighty Missions',
    `Daily missions reset on ${periods.dailyKey}. Weekly missions use the week beginning ${periods.weeklyKey}.`,
  )
  for (const periodType of ['daily', 'weekly']) {
    const lines = snapshots.filter((mission) => mission.periodType === periodType).map((mission) => {
      const state = mission.claimed ? 'Claimed' : mission.complete ? `Ready: \`nighty claim ${mission.id}\`` : `${mission.progress}/${mission.goal}`
      return `**${mission.title}** [${mission.id}]\n${mission.description} · ${state} · ${formatNightCurrency(mission.reward)}`
    })
    embed.addFields({
      name: periodType === 'daily' ? 'Daily' : 'Weekly',
      value: lines.join('\n\n'),
    })
  }
  return { embeds: [embed] }
}

function dailyPayload(result) {
  if (result.status === 'already_claimed') {
    return {
      embeds: [baseEmbed('Nighty Daily', `You already claimed today’s reward. Current streak: **${result.player.dailyStreak} days**.`)],
    }
  }
  return {
    embeds: [baseEmbed('Nighty Daily Claimed')
      .setDescription(`Received **${formatNightCurrency(result.reward)}**.`)
      .addFields(
        { name: 'Streak', value: `${result.player.dailyStreak}/7 days`, inline: true },
        { name: 'Balance', value: formatNightCurrency(result.player.balance), inline: true },
      )],
  }
}

function huntPayload(result) {
  if (result.status === 'cooldown') {
    return {
      embeds: [baseEmbed('Nighty Hunt Cooldown', `Your squad needs **${result.cooldownSeconds} more second${result.cooldownSeconds === 1 ? '' : 's'}** before the next hunt.`)],
    }
  }
  const character = result.character
  return {
    embeds: [baseEmbed('Nighty Hunt Complete', `You recruited **${character.name}**.`)
      .addFields(
        { name: 'Rarity', value: character.rarity, inline: true },
        { name: 'Reward', value: formatNightCurrency(result.reward), inline: true },
        { name: 'Owned', value: `x${result.quantity}`, inline: true },
        { name: 'Balance', value: formatNightCurrency(result.player.balance), inline: false },
      )],
  }
}

function battlePayload(result) {
  if (result.status === 'cooldown') {
    return {
      embeds: [baseEmbed('Nighty Battle Cooldown', `Your squad needs **${result.cooldownSeconds} more second${result.cooldownSeconds === 1 ? '' : 's'}** before another PvE battle.`)],
    }
  }
  const { character, enemy, playerRoll, enemyRoll, won } = result.battle
  const embed = baseEmbed(
    won ? 'Nighty PvE Victory' : 'Nighty PvE Defeat',
    `**${character.name}** fought **${enemy.name}** (${enemy.rank}).`,
  ).addFields(
    { name: 'Power roll', value: `${playerRoll} vs ${enemyRoll}`, inline: true },
    { name: 'Reward', value: won ? formatNightCurrency(result.reward) : 'No currency lost', inline: true },
    { name: 'Record', value: `${result.player.totalBattleWins}/${result.player.totalBattles} wins`, inline: true },
    { name: 'Balance', value: formatNightCurrency(result.player.balance), inline: false },
  )
  return { embeds: [embed] }
}

function challengeButtons(type, id) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`nighty:${type}:accept:${id}`)
      .setLabel('Accept')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`nighty:${type}:decline:${id}`)
      .setLabel('Decline')
      .setStyle(ButtonStyle.Danger),
  )]
}

function pvpChallengePayload(challenge) {
  return {
    content: `<@${challenge.opponentId}>, you received a Nighty PvP challenge.`,
    embeds: [baseEmbed('Nighty PvP Challenge', `<@${challenge.challengerId}> challenged <@${challenge.opponentId}>.`)
      .addFields(
        { name: 'Wager per player', value: formatNightCurrency(challenge.wager), inline: true },
        { name: 'Rule', value: 'Winner receives the wager from the loser. Both balances are checked again on acceptance.', inline: false },
      )],
    components: challengeButtons('pvp', challenge.id),
    allowedMentions: { parse: [], users: [challenge.opponentId], repliedUser: false },
  }
}

function pvpResolvedPayload(challenge) {
  if (challenge.status === 'completed') {
    return {
      content: `<@${challenge.winnerId}> won the Nighty PvP battle.`,
      embeds: [baseEmbed('Nighty PvP Result', `<@${challenge.winnerId}> defeated <@${challenge.loserId}> and won **${formatNightCurrency(challenge.wager)}**.`)],
      components: [],
      allowedMentions: { parse: [], users: [challenge.winnerId, challenge.loserId] },
    }
  }
  const messages = {
    declined: 'The challenged player declined this PvP battle.',
    expired: 'This PvP challenge expired.',
    cancelled: challenge.reason === 'insufficient_balance'
      ? 'The PvP challenge was cancelled because one player no longer has enough Night Currency.'
      : 'The PvP challenge was cancelled.',
  }
  return {
    content: null,
    embeds: [baseEmbed('Nighty PvP Closed', messages[challenge.status] || 'This PvP challenge is no longer available.')],
    components: [],
  }
}

function tradeOfferPayload(offer) {
  const character = NIGHTY_CHARACTER_BY_ID.get(offer.characterId)
  return {
    content: `<@${offer.buyerId}>, you received a Nighty trade offer.`,
    embeds: [baseEmbed('Nighty Private Trade', `<@${offer.sellerId}> offers **${character?.name || offer.characterId} x${offer.quantity}** to <@${offer.buyerId}>.`)
      .addFields({ name: 'Total price', value: formatNightCurrency(offer.price) })],
    components: challengeButtons('trade', offer.id),
    allowedMentions: { parse: [], users: [offer.buyerId], repliedUser: false },
  }
}

function tradeResolvedPayload(offer) {
  const character = NIGHTY_CHARACTER_BY_ID.get(offer.characterId)
  const descriptions = {
    completed: `<@${offer.buyerId}> bought **${character?.name || offer.characterId} x${offer.quantity}** from <@${offer.sellerId}> for **${formatNightCurrency(offer.price)}**.`,
    declined: 'The buyer declined this trade.',
    expired: 'This private trade expired.',
    cancelled: offer.reason === 'insufficient_balance'
      ? 'The trade was cancelled because the buyer no longer has enough Night Currency.'
      : 'The trade was cancelled because the offered characters are no longer available.',
  }
  return {
    content: null,
    embeds: [baseEmbed(offer.status === 'completed' ? 'Nighty Trade Complete' : 'Nighty Trade Closed', descriptions[offer.status] || 'This trade is no longer available.')],
    components: [],
  }
}

function marketPayload(listings) {
  const lines = listings.map((listing) => {
    const character = NIGHTY_CHARACTER_BY_ID.get(listing.characterId)
    return `\`${listing.id}\` · **${character?.name || listing.characterId} x${listing.quantity}** · ${formatNightCurrency(listing.price)} · seller <@${listing.sellerId}>`
  })
  return {
    embeds: [baseEmbed(
      'Nighty Market',
      lines.length > 0 ? `${lines.join('\n')}\n\nBuy with \`nighty buy <listing_id>\`.` : 'No active listings. Create one with `nighty market sell <character_id> <quantity> <price>`.',
    )],
  }
}

function marketResultPayload(title, description) {
  return { embeds: [baseEmbed(title, description)] }
}

function gameFailurePayload(title, result) {
  if (result.status === 'cooldown') {
    return marketResultPayload(title, `Try again in **${result.cooldownSeconds} second${result.cooldownSeconds === 1 ? '' : 's'}**.`)
  }
  if (result.status === 'insufficient_balance') {
    return marketResultPayload(title, `You do not have enough Night Currency. Current balance: **${formatNightCurrency(result.player.balance)}**.`)
  }
  if (result.status === 'duplicate') {
    return marketResultPayload(title, `This game was already settled. Current balance: **${formatNightCurrency(result.player.balance)}**.`)
  }
  return null
}

function gameBalanceFields(result) {
  return [
    { name: 'Payout', value: formatNightCurrency(result.payout), inline: true },
    { name: 'Net', value: `${result.net >= 0 ? '+' : '−'}${formatNightCurrency(Math.abs(result.net))}`, inline: true },
    { name: 'Balance', value: formatNightCurrency(result.player.balance), inline: false },
  ]
}

function slotsPayload(spin, result) {
  const failure = gameFailurePayload('Nighty Slots', result)
  if (failure) return failure
  const reels = spin.symbols.map((symbol) => symbol.label).join('  │  ')
  return {
    embeds: [baseEmbed(spin.won ? 'Nighty Slots Win' : 'Nighty Slots', `## ${reels}`)
      .addFields(
        { name: 'Result', value: spin.won ? `${spin.multiplier}× payout` : 'No matching pair', inline: true },
        { name: 'Bet', value: formatNightCurrency(result.wager), inline: true },
        ...gameBalanceFields(result),
      )],
  }
}

function coinflipPayload(flip, result) {
  const failure = gameFailurePayload('Nighty Coin Flip', result)
  if (failure) return failure
  return {
    embeds: [baseEmbed(flip.won ? 'Nighty Coin Flip Win' : 'Nighty Coin Flip Loss', `The coin landed on **${flip.result.toUpperCase()}**. You chose **${flip.choice.toUpperCase()}**.`)
      .addFields(
        { name: 'Bet', value: formatNightCurrency(result.wager), inline: true },
        ...gameBalanceFields(result),
      )],
  }
}

function fishingPayload(catchResult, result) {
  const failure = gameFailurePayload('Nighty Fishing', result)
  if (failure) return failure
  return {
    embeds: [baseEmbed('Nighty Fishing Catch', `You caught **${catchResult.name}**.`)
      .addFields(
        { name: 'Rarity', value: catchResult.rarity, inline: true },
        { name: 'Reward', value: formatNightCurrency(result.payout), inline: true },
        { name: 'Balance', value: formatNightCurrency(result.player.balance), inline: false },
      )],
  }
}

function adventurePayload(gameType, adventure, result) {
  const title = gameType === 'dungeon' ? 'Nighty Dungeon Raid' : 'Nighty Boss Fight'
  const failure = gameFailurePayload(title, result)
  if (failure) return failure
  return {
    embeds: [baseEmbed(`${title} ${adventure.won ? 'Victory' : 'Defeat'}`, `**${adventure.character.name}** faced **${adventure.encounter.name}**.`)
      .addFields(
        { name: 'Power roll', value: `${adventure.playerRoll} vs ${adventure.enemyRoll}`, inline: true },
        { name: 'Reward', value: adventure.won ? formatNightCurrency(result.payout) : 'No currency lost', inline: true },
        { name: 'Balance', value: formatNightCurrency(result.player.balance), inline: false },
      )],
  }
}

function blackjackButtons(id) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`nighty:blackjack:hit:${id}`).setLabel('Hit').setEmoji('➕').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`nighty:blackjack:stand:${id}`).setLabel('Stand').setEmoji('✋').setStyle(ButtonStyle.Secondary),
  )]
}

const BLACKJACK_SUIT_BASE = Object.freeze({
  '♠': 0x1F0A0,
  '♥': 0x1F0B0,
  '♦': 0x1F0C0,
  '♣': 0x1F0D0,
})

const BLACKJACK_RANK_OFFSET = Object.freeze({
  A: 1,
  2: 2,
  3: 3,
  4: 4,
  5: 5,
  6: 6,
  7: 7,
  8: 8,
  9: 9,
  10: 10,
  J: 11,
  Q: 13,
  K: 14,
})

export function blackjackCardFace(card) {
  const value = String(card || '')
  const suit = value.slice(-1)
  const rank = value.slice(0, -1)
  const base = BLACKJACK_SUIT_BASE[suit]
  const offset = BLACKJACK_RANK_OFFSET[rank]
  return base && offset ? String.fromCodePoint(base + offset) : '🂠'
}

function blackjackCardRow(cards) {
  return cards.map(blackjackCardFace).join('　')
}

function blackjackPayload(session, resolved = null) {
  const state = resolved?.state || session.state
  const playerValue = blackjackHandValue(state.player)
  const dealerValue = blackjackHandValue(state.dealer)
  const active = !resolved && session.status === 'active'
  const visibleDealerCards = active ? [state.dealer[0]] : state.dealer
  const visibleDealerValue = blackjackHandValue(visibleDealerCards)
  const dealerCards = `${blackjackCardRow(visibleDealerCards)}${active ? '　🂠' : ''}`
  const status = active
    ? `Wager: **${formatNightCurrency(session.wager)}** · Choose **Hit** or **Stand**.`
    : `Result: **${String(resolved?.outcome || session.outcome || session.status).toUpperCase()}**.`
  const description = [
    `**Dealer [${active ? `${visibleDealerValue} + ?` : dealerValue}]**`,
    `## ${dealerCards}`,
    `**You [${playerValue}]**`,
    `## ${blackjackCardRow(state.player)}`,
    status,
  ].join('\n')
  const embed = baseEmbed(active ? 'Nighty Blackjack' : 'Nighty Blackjack Result', description)
  if (!active) {
    embed.addFields(
      { name: 'Payout', value: formatNightCurrency(resolved?.payout || session.payout || 0), inline: true },
      { name: 'Balance', value: formatNightCurrency(resolved?.balance || session.balance || 0), inline: true },
    )
  }
  return { embeds: [embed], components: active ? blackjackButtons(session.id) : [] }
}

function joinedPartyPlayers(session) {
  return session.players.filter((player) => player.status === 'joined')
}

function allInConfirmationPayload(session, buttonGameType) {
  const wager = joinedPartyPlayers(session)[0]?.wager || session.state.baseWager || 0
  return {
    embeds: [baseEmbed('Confirm All-In Wager', `You are about to wager your complete balance: **${formatNightCurrency(wager)}**.`)
      .addFields({ name: 'Protection', value: 'The wager is locked safely and will be refunded if you cancel or the confirmation expires.' })],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`nighty:${buttonGameType}:confirm_allin:${session.id}`).setLabel('Confirm All-In').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`nighty:${buttonGameType}:cancel_allin:${session.id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    )],
  }
}

function strongestOwnedCharacters(collection, limit = 4) {
  return collection
    .filter((item) => item.quantity > 0)
    .map((item) => NIGHTY_CHARACTER_BY_ID.get(item.characterId))
    .filter(Boolean)
    .sort((left, right) => right.power - left.power)
    .slice(0, limit)
}

function shadowDuelChallengePayload(session) {
  const choices = session.state.opponentChoices || []
  const buttons = choices.map((character) => new ButtonBuilder()
    .setCustomId(`nighty:duel:accept_${character.id}:${session.id}`)
    .setLabel(character.name.slice(0, 80))
    .setStyle(ButtonStyle.Success))
  buttons.push(new ButtonBuilder()
    .setCustomId(`nighty:duel:decline:${session.id}`)
    .setLabel('Decline')
    .setStyle(ButtonStyle.Danger))
  return {
    content: `<@${session.state.opponentId}>, choose a fighter to accept this Shadow Duel.`,
    embeds: [baseEmbed('Nighty Shadow Duel', `<@${session.hostId}> challenged <@${session.state.opponentId}>.`)
      .addFields(
        { name: 'Challenger fighter', value: `${session.state.challengerCharacter.name} · ${session.state.challengerCharacter.power} power`, inline: true },
        { name: 'Wager per player', value: formatNightCurrency(session.state.baseWager), inline: true },
        { name: 'Rules', value: 'Five simultaneous rounds. Secretly choose Attack, Defend, or your one-use Skill.', inline: false },
      )],
    components: [new ActionRowBuilder().addComponents(...buttons.slice(0, 5))],
    allowedMentions: { parse: [], users: [session.state.opponentId], repliedUser: false },
  }
}

function shadowDuelPayload(session) {
  const state = session.state
  const fighters = (state.order || []).map((userId) => state.fighters?.[userId]).filter(Boolean)
  const active = session.status === 'active' && state.phase === 'active'
  const lines = fighters.map((fighter) => {
    const hpBlocks = Math.max(0, Math.round((fighter.hp / fighter.maxHp) * 10))
    const bar = `${'█'.repeat(hpBlocks)}${'░'.repeat(10 - hpBlocks)}`
    return `<@${fighter.userId}> — **${fighter.characterName}**
${bar} **${fighter.hp}/${fighter.maxHp} HP** · Skill ${fighter.skillReady ? 'ready' : 'used'} · ${fighter.action ? 'move locked' : 'choosing'}`
  })
  const title = state.tied ? 'Shadow Duel Draw' : state.winnerId ? 'Shadow Duel Victory' : `Shadow Duel · Round ${state.round}/${state.maxRounds}`
  const embed = baseEmbed(title, `${lines.join('\n\n')}\n\n${state.log || ''}`)
    .addFields({ name: 'Pot', value: formatNightCurrency(Number(state.wager || 0) * 2), inline: true })
  if (state.winnerId) embed.addFields({ name: 'Winner', value: `<@${state.winnerId}>`, inline: true })
  if (state.tied) embed.addFields({ name: 'Settlement', value: 'Draw · both wagers refunded', inline: true })
  const components = active ? [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`nighty:duel:attack:${session.id}`).setLabel('Attack').setEmoji('⚔️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`nighty:duel:defend:${session.id}`).setLabel('Defend').setEmoji('🛡️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`nighty:duel:skill:${session.id}`).setLabel('Skill').setEmoji('🌑').setStyle(ButtonStyle.Danger),
  )] : []
  return { embeds: [embed], components }
}

function minesPayload(session) {
  const state = session.state
  const active = session.status === 'active' && state.phase === 'active'
  const multiplier = nightyMinesMultiplier(state)
  const participant = session.players[0]
  const wager = participant?.wager || 0
  const payout = state.revealed.length > 0 ? nightyMinesPayout(wager, state) : wager
  const grid = []
  for (let rowIndex = 0; rowIndex < 4; rowIndex += 1) {
    const row = new ActionRowBuilder()
    for (let column = 0; column < 4; column += 1) {
      const cell = rowIndex * 4 + column
      const revealed = state.revealed.includes(cell)
      const exploded = state.lastPick === cell && state.mines.includes(cell)
      const showMine = !active && state.mines.includes(cell)
      const button = new ButtonBuilder()
        .setCustomId(`nighty:mines:pick_${cell}:${session.id}`)
        .setLabel(exploded || showMine ? '💣' : revealed ? '🌙' : String(cell + 1))
        .setStyle(exploded || showMine ? ButtonStyle.Danger : revealed ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setDisabled(!active || revealed)
      row.addComponents(button)
    }
    grid.push(row)
  }
  const status = state.phase === 'lost'
    ? 'A mine ended the run.'
    : state.phase === 'cleared'
      ? 'Board cleared — maximum payout secured.'
      : `Choose a tile or cash out for **${formatNightCurrency(payout)}**.`
  const embed = baseEmbed(state.phase === 'lost' ? 'Nighty Abyss Mines · Detonated' : 'Nighty Abyss Mines', status)
    .addFields(
      { name: 'Bet', value: formatNightCurrency(wager), inline: true },
      { name: 'Mines', value: `${state.mineCount}/${NIGHTY_MINES_CELLS}`, inline: true },
      { name: 'Multiplier', value: `${multiplier.toFixed(2)}×`, inline: true },
      { name: 'Safe tiles', value: String(state.revealed.length), inline: true },
    )
  if (!active && participant) embed.addFields({ name: 'Payout', value: formatNightCurrency(participant.payout), inline: true })
  if (active) grid.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`nighty:mines:cashout:${session.id}`)
      .setLabel('Cash Out')
      .setEmoji('💰')
      .setStyle(ButtonStyle.Success)
      .setDisabled(state.revealed.length === 0),
  ))
  return { embeds: [embed], components: grid }
}

function crashLobbyPayload(session) {
  const players = joinedPartyPlayers(session)
  const lines = players.map((player, index) => `${index + 1}. <@${player.userId}>${player.userId === session.hostId ? ' · host' : ''}`)
  return {
    embeds: [baseEmbed('Nighty Nightfall Crash · Lobby', lines.join('\n') || 'Waiting for players.')
      .addFields(
        { name: 'Bet per player', value: formatNightCurrency(session.state.baseWager), inline: true },
        { name: 'Players', value: `${players.length}/10`, inline: true },
        { name: 'How it works', value: 'After the host starts, any active rider can push the shared multiplier. Cash out before the hidden crash point.', inline: false },
      )],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`nighty:crash:join:${session.id}`).setLabel('Join').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`nighty:crash:leave:${session.id}`).setLabel('Leave').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`nighty:crash:start:${session.id}`).setLabel('Start').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`nighty:crash:cancel:${session.id}`).setLabel('Cancel').setStyle(ButtonStyle.Danger),
    )],
  }
}

function crashPayload(session) {
  const state = session.state
  const active = session.status === 'active' && state.phase === 'active'
  const multiplier = nightyCrashMultiplier(state)
  const participants = joinedPartyPlayers(session)
  const lines = participants.map((participant) => {
    const player = state.players?.[participant.userId]
    if (player?.status === 'cashed_out') return `<@${participant.userId}> · cashed at **${player.multiplier.toFixed(2)}×** · ${formatNightCurrency(player.payout)}`
    return `<@${participant.userId}> · ${state.phase === 'crashed' ? 'crashed' : 'riding'}`
  })
  const title = state.phase === 'crashed' ? 'Nightfall Crash · CRASHED' : state.phase === 'completed' ? 'Nightfall Crash · Complete' : 'Nightfall Crash'
  const embed = baseEmbed(title, `# ${multiplier.toFixed(2)}×\n\n${lines.join('\n')}`)
    .addFields({ name: 'Shared decision', value: active ? 'Push raises the multiplier for everyone still riding.' : 'Round settled.', inline: false })
  return {
    embeds: [embed],
    components: active ? [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`nighty:crash:push:${session.id}`).setLabel('Push Multiplier').setEmoji('🚀').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`nighty:crash:cashout:${session.id}`).setLabel('Cash Out').setEmoji('💰').setStyle(ButtonStyle.Success),
    )] : [],
  }
}

function partyBlackjackLobbyPayload(session) {
  const players = joinedPartyPlayers(session)
  return {
    embeds: [baseEmbed('Nighty Blackjack Table · Lobby', players.map((player) => `<@${player.userId}>${player.userId === session.hostId ? ' · dealer host' : ''}`).join('\n'))
      .addFields(
        { name: 'Bet per player', value: formatNightCurrency(session.state.baseWager), inline: true },
        { name: 'Seats', value: `${players.length}/4`, inline: true },
        { name: 'Table actions', value: 'Hit · Stand · Double · Split', inline: false },
      )],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`nighty:blackjack_multi:join:${session.id}`).setLabel('Join Table').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`nighty:blackjack_multi:leave:${session.id}`).setLabel('Leave').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`nighty:blackjack_multi:deal:${session.id}`).setLabel('Deal').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`nighty:blackjack_multi:cancel:${session.id}`).setLabel('Cancel').setStyle(ButtonStyle.Danger),
    )],
  }
}

function partyBlackjackPayload(session) {
  const state = session.state
  const active = session.status === 'active' && state.phase === 'active'
  const resolved = session.status === 'completed' || state.phase === 'completed'
  const visibleDealer = resolved ? state.dealer : [state.dealer[0]]
  const dealerCards = `${blackjackCardRow(visibleDealer)}${resolved ? '' : '　🂠'}`
  const playerSections = (state.order || []).map((userId) => {
    const player = state.players[userId]
    const hands = player.hands.map((hand, index) => {
      const marker = state.currentUserId === userId && player.activeHand === index ? '▶ ' : ''
      const outcome = hand.outcome ? ` · ${hand.outcome.toUpperCase()}` : ''
      return `${marker}${blackjackCardRow(hand.cards)} **[${blackjackHandValue(hand.cards)}]** · ${formatNightCurrency(hand.wager)}${outcome}`
    }).join('\n')
    const settlement = session.players.find((entry) => entry.userId === userId)
    return `**<@${userId}>**${resolved ? ` · payout ${formatNightCurrency(settlement?.payout || 0)}` : ''}\n${hands}`
  })
  const embed = baseEmbed(resolved ? 'Nighty Multiplayer Blackjack · Result' : 'Nighty Multiplayer Blackjack', `**Dealer**\n## ${dealerCards}\n\n${playerSections.join('\n\n')}`)
  if (active) embed.addFields({ name: 'Current turn', value: `<@${state.currentUserId}>`, inline: true })
  return {
    embeds: [embed],
    components: active ? [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`nighty:blackjack_multi:hit:${session.id}`).setLabel('Hit').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`nighty:blackjack_multi:stand:${session.id}`).setLabel('Stand').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`nighty:blackjack_multi:double:${session.id}`).setLabel('Double').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`nighty:blackjack_multi:split:${session.id}`).setLabel('Split').setStyle(ButtonStyle.Danger),
    )] : [],
  }
}

function triviaButtons(session) {
  return [new ActionRowBuilder().addComponents(
    ...session.state.choices.map((choice, index) => new ButtonBuilder()
      .setCustomId(`nighty:trivia:answer_${index}:${session.id}`)
      .setLabel(`${String.fromCharCode(65 + index)}. ${choice}`.slice(0, 80))
      .setStyle(ButtonStyle.Secondary)),
  )]
}

function triviaPayload(session) {
  return {
    embeds: [baseEmbed('Nighty Trivia', session.state.question)
      .setDescription(`${session.state.question}\n\nChoose an answer within 45 seconds for **${formatNightCurrency(NIGHTY_TRIVIA_REWARD)}**.`)],
    components: triviaButtons(session),
  }
}

function triviaResultPayload(session, selectedIndex) {
  const correct = session.outcome === 'correct'
  const answer = session.state.choices[session.state.correctIndex]
  const selected = session.state.choices[selectedIndex]
  return {
    embeds: [baseEmbed(correct ? 'Nighty Trivia Correct' : 'Nighty Trivia Incorrect', `You chose **${selected}**. The correct answer is **${answer}**.`)
      .addFields(
        { name: 'Payout', value: formatNightCurrency(session.payout), inline: true },
        { name: 'Balance', value: formatNightCurrency(session.balance), inline: true },
      )],
    components: [],
  }
}

function wordPayload(session) {
  return {
    embeds: [baseEmbed('Nighty Word Scramble', `Unscramble **${String(session.state.scrambled).toUpperCase()}**.`)
      .addFields(
        { name: 'Answer', value: '`nighty word <answer>`', inline: true },
        { name: 'Reward', value: formatNightCurrency(NIGHTY_WORD_REWARD), inline: true },
      )],
  }
}

function wordResultPayload(session, guess) {
  const correct = session.outcome === 'correct'
  return {
    embeds: [baseEmbed(correct ? 'Nighty Word Correct' : 'Nighty Word Incorrect', correct
      ? `**${guess.toUpperCase()}** is correct.`
      : `Your guess **${guess.toUpperCase()}** was incorrect. The word was **${String(session.state.answer).toUpperCase()}**.`)
      .addFields(
        { name: 'Payout', value: formatNightCurrency(session.payout), inline: true },
        { name: 'Balance', value: formatNightCurrency(session.balance), inline: true },
      )],
  }
}

function statsPayload(stats) {
  if (stats.length === 0) return marketResultPayload('Nighty Game Records', 'Play a Nighty game to create your first record.')
  const lines = stats.map((row) => `**${row.gameType}** · ${row.wins}/${row.plays} wins · wagered ${formatNightCurrency(row.totalWagered)} · paid ${formatNightCurrency(row.totalPaid)}`)
  return { embeds: [baseEmbed('Nighty Game Records', lines.join('\n'))] }
}

function leaderboardPayload(players) {
  const medals = ['🥇', '🥈', '🥉']
  const lines = players.map((player, index) => `${medals[index] || `**${index + 1}.**`} <@${player.userId}> · **${formatNightCurrency(player.balance)}**`)
  return {
    embeds: [baseEmbed('Nighty Currency Leaderboard', lines.length > 0 ? lines.join('\n') : 'No Nighty players have joined this server yet.')],
  }
}

function adminHelpPayload() {
  return {
    embeds: [baseEmbed('Nighty Economy Administration', 'Requires Manage Server, Administrator, or a configured Nighty admin role.')
      .addFields(
        { name: 'Balances', value: '`nighty admin grant @player <amount> [reason]`\n`nighty admin remove @player <amount> [reason]`\n`nighty admin set @player <amount> [reason]`' },
        { name: 'Recovery', value: '`nighty admin reset-cooldowns @player [reason]`' },
        { name: 'Monitoring', value: '`nighty admin economy`\n`nighty admin audit [@player]`' },
        { name: 'Audit rule', value: 'Every successful change records the acting admin, target, amount, before/after balances, reason, and Discord message ID.' },
      )],
  }
}

function adminActionPayload(result) {
  if (result.status === 'missing_player') {
    return marketResultPayload('Nighty Admin Failed', 'That player does not have a Nighty profile yet.')
  }
  if (result.status === 'insufficient_balance') {
    return marketResultPayload('Nighty Admin Failed', `That removal would make the balance negative. Current balance: **${formatNightCurrency(result.player.balance)}**.`)
  }
  if (result.status === 'duplicate') {
    return marketResultPayload('Nighty Admin Duplicate', `This Discord message was already applied. <@${result.targetId}> remains at **${formatNightCurrency(result.player.balance)}**.`)
  }
  const labels = {
    grant: 'granted currency to',
    remove: 'removed currency from',
    set: 'set the balance for',
    reset_cooldowns: 'reset all cooldowns for',
  }
  return {
    embeds: [baseEmbed('Nighty Admin Applied', `<@${result.adminId}> ${labels[result.action] || 'updated'} <@${result.targetId}>.`)
      .addFields(
        { name: 'Action', value: result.action.replace(/_/g, ' '), inline: true },
        { name: 'Amount', value: formatNightCurrency(result.amount), inline: true },
        { name: 'Before', value: formatNightCurrency(result.balanceBefore), inline: true },
        { name: 'After', value: formatNightCurrency(result.balanceAfter), inline: true },
        { name: 'Reason', value: result.reason, inline: false },
      )],
  }
}

function adminAuditPayload(actions, targetId = null) {
  const lines = actions.map((action) => {
    const reason = String(action.reason).replace(/[`\r\n]+/g, ' ').slice(0, 200)
    return `\`#${action.id}\` **${action.action.replace(/_/g, ' ')}** · <@${action.adminId}> → <@${action.targetId}> · ${formatNightCurrency(action.balanceBefore)} → ${formatNightCurrency(action.balanceAfter)}\n${reason}`
  })
  return {
    embeds: [baseEmbed(targetId ? 'Nighty Player Audit' : 'Nighty Admin Audit', lines.length > 0 ? lines.join('\n\n') : 'No matching Nighty administration actions were found.')],
  }
}

function economySummaryPayload(summary) {
  return {
    embeds: [baseEmbed('Nighty Economy Summary')
      .addFields(
        { name: 'Players', value: String(summary.players), inline: true },
        { name: 'Total currency', value: formatNightCurrency(summary.totalCurrency), inline: true },
        { name: 'Average balance', value: formatNightCurrency(summary.averageBalance), inline: true },
        { name: 'Active market listings', value: String(summary.activeListings), inline: true },
        { name: 'Active PvP challenges', value: String(summary.activeChallenges), inline: true },
        { name: 'Active private trades', value: String(summary.activeTrades), inline: true },
        { name: 'Active game sessions', value: String(summary.activeSessions), inline: true },
        { name: 'Ledger entries', value: String(summary.ledgerEntries), inline: true },
      )],
  }
}

function missionClaimPayload(mission, result) {
  if (result.status === 'locked') {
    return {
      embeds: [baseEmbed('Mission Not Complete', `**${mission.title}** is at ${Math.min(result.progress, mission.goal)}/${mission.goal}.`)],
    }
  }
  if (result.status === 'already_claimed') {
    return { embeds: [baseEmbed('Mission Already Claimed', `You already claimed **${mission.title}**.`)] }
  }
  return {
    embeds: [baseEmbed('Mission Reward Claimed', `**${mission.title}** paid **${formatNightCurrency(result.reward)}**.`)
      .addFields({ name: 'Balance', value: formatNightCurrency(result.player.balance) })],
  }
}

function unknownPayload(command) {
  return {
    embeds: [baseEmbed('Unknown Nighty Command', `I do not recognize \`${command}\`. Type \`nighty help\` to see the available commands.`)],
  }
}

function safeReply(message, payload) {
  return message.reply({
    ...payload,
    allowedMentions: payload.allowedMentions || { parse: [], repliedUser: false },
    ...(message.id ? { nonce: String(message.id), enforceNonce: true } : {}),
  })
}

export function createNightyWorkflow(options = {}) {
  const store = options.store || createSupabaseNightyStore(options)
  const random = options.random || Math.random
  const now = options.now || (() => new Date())
  const timeZone = options.timeZone || NIGHTY_TIME_ZONE
  const createId = options.createId || (() => randomUUID())
  const createListingId = options.createListingId || (() => randomUUID().replace(/-/g, '').slice(0, 8))
  const createGameId = options.createGameId || (() => randomUUID())
  const createBlackjack = options.createBlackjack || (() => createBlackjackState(random))
  const adminRoleIds = options.adminRoleIds || String(process.env.NIGHTY_ADMIN_ROLE_IDS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)

  async function initialize() {
    await store.initialize()
  }

  async function refundExpiredPartySessions() {
    return store.refundExpiredPartySessions?.({ now: now() }) || 0
  }

  async function handleMessage(message) {
    if (message.author?.bot || !message.inGuild?.()) return { status: 'ignored' }
    const parsed = parseNightyCommand(message.content)
    if (!parsed) return { status: 'ignored' }
    if (parsed.command === 'help') {
      await safeReply(message, helpPayload())
      return { status: 'handled', command: 'help' }
    }
    if (parsed.command === 'game_help') {
      await safeReply(message, gameHelpPayload())
      return { status: 'handled', command: 'game_help' }
    }

    const guildId = message.guildId
    const userId = message.author.id
    const currentTime = now()

    if (parsed.command === 'leaderboard') {
      const players = await store.getLeaderboard({ guildId, limit: 10 })
      await safeReply(message, leaderboardPayload(players))
      return { status: 'handled', command: 'leaderboard', players }
    }

    if (parsed.command === 'admin') {
      if (!hasNightyAdminPermission(message, adminRoleIds)) {
        await safeReply(message, marketResultPayload('Nighty Admin Denied', 'You need Manage Server, Administrator, or a configured Nighty admin role to use this command.'))
        return { status: 'handled', command: 'admin', reason: 'forbidden' }
      }
      const subcommand = String(parsed.args[0] || 'help').toLowerCase()
      if (subcommand === 'help') {
        await safeReply(message, adminHelpPayload())
        return { status: 'handled', command: 'admin_help' }
      }
      if (subcommand === 'economy') {
        const summary = await store.getEconomySummary({ guildId })
        await safeReply(message, economySummaryPayload(summary))
        return { status: 'handled', command: 'admin_economy', summary }
      }
      if (subcommand === 'audit') {
        const targetId = parsed.args[1] ? mentionedUserId(parsed.args[1]) : null
        if (parsed.args[1] && !targetId) {
          await safeReply(message, marketResultPayload('Nighty Admin Audit', 'Usage: `nighty admin audit [@player]`.'))
          return { status: 'handled', command: 'admin_audit', reason: 'invalid_target' }
        }
        const actions = await store.getAdminAudit({ guildId, targetId, limit: 10 })
        await safeReply(message, adminAuditPayload(actions, targetId))
        return { status: 'handled', command: 'admin_audit', actions }
      }
      if (subcommand === 'reset' || subcommand === 'reset-cooldowns') {
        const targetId = mentionedUserId(parsed.args[1])
        if (!targetId) {
          await safeReply(message, marketResultPayload('Nighty Admin Cooldown Reset', 'Usage: `nighty admin reset-cooldowns @player [reason]`.'))
          return { status: 'handled', command: 'admin_reset', reason: 'invalid_target' }
        }
        const reason = parsed.args.slice(2).join(' ').trim().slice(0, 200) || 'Manual cooldown reset'
        const result = await store.adminResetCooldowns({
          guildId,
          adminId: userId,
          targetId,
          reason,
          actionId: message.id || `${userId}:${currentTime.getTime()}`,
          now: currentTime,
        })
        await safeReply(message, adminActionPayload(result))
        return { status: 'handled', command: 'admin_reset', result }
      }
      if (['grant', 'remove', 'set'].includes(subcommand)) {
        const targetId = mentionedUserId(parsed.args[1])
        const amount = parseAdminAmount(parsed.args[2], subcommand === 'set')
        if (!targetId || amount === null || (subcommand !== 'set' && amount === 0)) {
          await safeReply(message, marketResultPayload('Nighty Balance Administration', `Usage: \`nighty admin ${subcommand} @player <amount> [reason]\`.`))
          return { status: 'handled', command: `admin_${subcommand}`, reason: 'invalid_arguments' }
        }
        const reason = parsed.args.slice(3).join(' ').trim().slice(0, 200) || `Manual ${subcommand}`
        const result = await store.adminAdjustBalance({
          guildId,
          adminId: userId,
          targetId,
          operation: subcommand,
          amount,
          reason,
          actionId: message.id || `${userId}:${currentTime.getTime()}`,
          now: currentTime,
        })
        await safeReply(message, adminActionPayload(result))
        return { status: 'handled', command: `admin_${subcommand}`, result }
      }
      await safeReply(message, adminHelpPayload())
      return { status: 'handled', command: 'admin_help', reason: 'unknown_subcommand' }
    }

    const periods = nightyPeriodKeys(currentTime, timeZone)
    const ensured = await store.ensurePlayer({ guildId, userId })

    if (parsed.command === 'balance') {
      await safeReply(message, balancePayload(ensured.player, ensured.isNew))
      return { status: 'handled', command: 'balance', player: ensured.player }
    }

    if (parsed.command === 'stats') {
      const stats = await store.getGameStats({ guildId, userId })
      await safeReply(message, statsPayload(stats))
      return { status: 'handled', command: 'stats', stats }
    }

    if (parsed.command === 'profile') {
      const [player, collection] = await Promise.all([
        store.getPlayer({ guildId, userId }),
        store.getCollection({ guildId, userId }),
      ])
      await safeReply(message, profilePayload(player, collection, ensured.isNew))
      return { status: 'handled', command: 'profile', player }
    }

    if (parsed.command === 'collection') {
      const collection = await store.getCollection({ guildId, userId })
      await safeReply(message, collectionPayload(ensured.player, collection))
      return { status: 'handled', command: 'collection', collection }
    }

    if (parsed.command === 'daily') {
      const result = await store.claimDaily({ guildId, userId, ...periods })
      await safeReply(message, dailyPayload(result))
      return { status: 'handled', command: 'daily', result }
    }

    if (parsed.command === 'hunt') {
      const character = selectNightyCharacter(random)
      const result = await store.recordHunt({
        guildId,
        userId,
        character,
        actionId: message.id || `${userId}:${currentTime.getTime()}`,
        cooldownSeconds: NIGHTY_HUNT_COOLDOWN_SECONDS,
        ...periods,
        now: currentTime,
      })
      await safeReply(message, huntPayload(result))
      return { status: 'handled', command: 'hunt', result }
    }

    if (parsed.command === 'battle') {
      const collection = await store.getCollection({ guildId, userId })
      const strongest = collection
        .filter((item) => item.quantity > 0)
        .map((item) => NIGHTY_CHARACTER_BY_ID.get(item.characterId))
        .filter(Boolean)
        .sort((left, right) => right.power - left.power)[0]
      if (!strongest) {
        await safeReply(message, marketResultPayload('Nighty Battle Locked', 'Use `nighty hunt` to recruit a character before entering PvE battles.'))
        return { status: 'handled', command: 'battle', reason: 'empty_collection' }
      }
      const battle = resolveNightyBattle(strongest, random)
      const result = await store.recordBattle({
        guildId,
        userId,
        battle,
        actionId: message.id || `${userId}:${currentTime.getTime()}`,
        cooldownSeconds: NIGHTY_BATTLE_COOLDOWN_SECONDS,
        now: currentTime,
      })
      await safeReply(message, battlePayload(result))
      return { status: 'handled', command: 'battle', result }
    }

    if (parsed.command === 'slots') {
      const wagerInput = parseNightyWager(parsed.args[0], ensured.player.balance)
      if (!validCasinoWager(wagerInput)) {
        await safeReply(message, marketResultPayload('Nighty Slots', `Usage: \`nighty sl <bet|all>\`. Numeric bets must be between **${formatNightCurrency(NIGHTY_MIN_BET)}** and **${formatNightCurrency(NIGHTY_MAX_BET)}**.`))
        return { status: 'handled', command: 'slots', reason: 'invalid_bet' }
      }
      const wager = wagerInput.amount
      const spin = spinNightySlots(random)
      const result = await store.recordGameResult({
        guildId,
        userId,
        gameType: 'slots',
        wager,
        payout: Math.floor(wager * spin.multiplier),
        won: spin.won,
        actionId: message.id || `${userId}:${currentTime.getTime()}`,
        ...periods,
        now: currentTime,
      })
      await safeReply(message, slotsPayload(spin, result))
      return { status: 'handled', command: 'slots', spin, result }
    }

    if (parsed.command === 'coinflip') {
      const first = String(parsed.args[0] || '').toLowerCase()
      const second = String(parsed.args[1] || '').toLowerCase()
      const choice = ['heads', 'tails'].includes(first) ? first : ['heads', 'tails'].includes(second) ? second : null
      const wagerInput = parseNightyWager(choice === first ? parsed.args[1] : parsed.args[0], ensured.player.balance)
      if (!choice || !validCasinoWager(wagerInput)) {
        await safeReply(message, marketResultPayload('Nighty Coin Flip', `Usage: \`nighty cf <heads|tails> <bet|all>\`. Numeric bets must be between **${formatNightCurrency(NIGHTY_MIN_BET)}** and **${formatNightCurrency(NIGHTY_MAX_BET)}**.`))
        return { status: 'handled', command: 'coinflip', reason: 'invalid_arguments' }
      }
      const wager = wagerInput.amount
      const flip = flipNightyCoin(choice, random)
      const result = await store.recordGameResult({
        guildId,
        userId,
        gameType: 'coinflip',
        wager,
        payout: wager * flip.multiplier,
        won: flip.won,
        actionId: message.id || `${userId}:${currentTime.getTime()}`,
        ...periods,
        now: currentTime,
      })
      await safeReply(message, coinflipPayload(flip, result))
      return { status: 'handled', command: 'coinflip', flip, result }
    }

    if (parsed.command === 'mines') {
      const wagerInput = parseNightyWager(parsed.args[0], ensured.player.balance)
      const mineCount = parsed.args[1] === undefined ? 3 : positiveQuantity(parsed.args[1])
      if (!validCasinoWager(wagerInput) || !mineCount || mineCount < NIGHTY_MIN_MINES || mineCount > NIGHTY_MAX_MINES) {
        await safeReply(message, marketResultPayload('Nighty Abyss Mines', `Usage: \`nighty mines <bet|all> [${NIGHTY_MIN_MINES}-${NIGHTY_MAX_MINES} mines]\`.`))
        return { status: 'handled', command: 'mines', reason: 'invalid_arguments' }
      }
      const session = await store.createPartySession({
        id: createGameId(),
        guildId,
        channelId: message.channelId || '',
        hostId: userId,
        gameType: 'mines',
        wager: wagerInput.amount,
        state: { ...createNightyMinesState(mineCount, random), allInPending: wagerInput.allIn },
        status: 'active',
        expiresAt: new Date(currentTime.getTime() + NIGHTY_PARTY_EXPIRY_SECONDS * 1000).toISOString(),
        now: currentTime,
      })
      if (session.mutationStatus === 'insufficient_balance') {
        await safeReply(message, marketResultPayload('Nighty Abyss Mines', `You do not have enough Night Currency. Balance: **${formatNightCurrency(session.balance)}**.`))
        return { status: 'handled', command: 'mines', reason: 'insufficient_balance' }
      }
      await safeReply(message, session.state.allInPending
        ? allInConfirmationPayload(session, 'mines')
        : minesPayload(session))
      return { status: 'handled', command: 'mines', session }
    }

    if (parsed.command === 'crash') {
      const wagerInput = parseNightyWager(parsed.args[0], ensured.player.balance)
      if (!validCasinoWager(wagerInput)) {
        await safeReply(message, marketResultPayload('Nighty Nightfall Crash', '`nighty crash <bet|all>` creates a shared lobby. Every player joins for the same wager.'))
        return { status: 'handled', command: 'crash', reason: 'invalid_bet' }
      }
      const session = await store.createPartySession({
        id: createGameId(),
        guildId,
        channelId: message.channelId || '',
        hostId: userId,
        gameType: 'crash',
        wager: wagerInput.amount,
        state: { ...createNightyCrashState(wagerInput.amount, random), allInPending: wagerInput.allIn },
        status: 'lobby',
        expiresAt: new Date(currentTime.getTime() + NIGHTY_PARTY_EXPIRY_SECONDS * 1000).toISOString(),
        now: currentTime,
      })
      if (session.mutationStatus === 'insufficient_balance') {
        await safeReply(message, marketResultPayload('Nighty Nightfall Crash', `You do not have enough Night Currency. Balance: **${formatNightCurrency(session.balance)}**.`))
        return { status: 'handled', command: 'crash', reason: 'insufficient_balance' }
      }
      await safeReply(message, session.state.allInPending
        ? allInConfirmationPayload(session, 'crash')
        : session.status === 'lobby' ? crashLobbyPayload(session) : crashPayload(session))
      return { status: 'handled', command: 'crash', session }
    }

    if (parsed.command === 'blackjack' || parsed.command === 'blackjack_multi') {
      const tableKeyword = ['table', 'multi', 'multiplayer'].includes(String(parsed.args[0] || '').toLowerCase())
      const multiplayer = parsed.command === 'blackjack_multi' || tableKeyword
      const wagerToken = parsed.args[multiplayer && tableKeyword ? 1 : 0]
      const wagerInput = parseNightyWager(wagerToken, ensured.player.balance)
      if (!validCasinoWager(wagerInput)) {
        await safeReply(message, marketResultPayload('Nighty Blackjack', multiplayer
          ? '`nighty bj table <bet|all>` creates a table for up to four players.'
          : `Usage: \`nighty bj <bet|all>\`. Numeric bets must be between **${formatNightCurrency(NIGHTY_MIN_BET)}** and **${formatNightCurrency(NIGHTY_MAX_BET)}**.`))
        return { status: 'handled', command: 'blackjack', reason: 'invalid_bet' }
      }
      const wager = wagerInput.amount
      if (multiplayer) {
        const session = await store.createPartySession({
          id: createGameId(),
          guildId,
          channelId: message.channelId || '',
          hostId: userId,
          gameType: 'blackjack_multi',
          wager,
          state: { phase: 'lobby', baseWager: wager, maxPlayers: 4, allInPending: wagerInput.allIn },
          status: 'lobby',
          expiresAt: new Date(currentTime.getTime() + NIGHTY_PARTY_EXPIRY_SECONDS * 1000).toISOString(),
          now: currentTime,
        })
        if (session.mutationStatus === 'insufficient_balance') {
          await safeReply(message, marketResultPayload('Nighty Blackjack Table', `You do not have enough Night Currency. Balance: **${formatNightCurrency(session.balance)}**.`))
          return { status: 'handled', command: 'blackjack_multi', reason: 'insufficient_balance' }
        }
        await safeReply(message, session.state.allInPending
          ? allInConfirmationPayload(session, 'blackjack_multi')
          : session.status === 'lobby' ? partyBlackjackLobbyPayload(session) : partyBlackjackPayload(session))
        return { status: 'handled', command: 'blackjack_multi', session }
      }
      const session = await store.startGameSession({
        id: createGameId(),
        guildId,
        channelId: message.channelId || '',
        userId,
        gameType: 'blackjack',
        wager,
        state: createBlackjack(),
        expiresAt: new Date(currentTime.getTime() + NIGHTY_BLACKJACK_EXPIRY_SECONDS * 1000).toISOString(),
        now: currentTime,
      })
      if (session.startStatus === 'insufficient_balance') {
        await safeReply(message, marketResultPayload('Nighty Blackjack', `You no longer have enough Night Currency. Balance: **${formatNightCurrency(session.balance)}**.`))
        return { status: 'handled', command: 'blackjack', reason: 'insufficient_balance' }
      }
      await safeReply(message, blackjackPayload(session))
      return { status: 'handled', command: 'blackjack', session }
    }

    if (parsed.command === 'trivia') {
      const question = selectNightyTrivia(random)
      const session = await store.startGameSession({
        id: createGameId(),
        guildId,
        channelId: message.channelId || '',
        userId,
        gameType: 'trivia',
        wager: 0,
        state: {
          questionId: question.id,
          question: question.question,
          choices: question.choices,
          correctIndex: question.correctIndex,
        },
        expiresAt: new Date(currentTime.getTime() + NIGHTY_TRIVIA_EXPIRY_SECONDS * 1000).toISOString(),
        now: currentTime,
      })
      await safeReply(message, triviaPayload(session))
      return { status: 'handled', command: 'trivia', session }
    }

    if (parsed.command === 'fish') {
      const caught = catchNightyFish(random)
      const result = await store.recordGameResult({
        guildId,
        userId,
        gameType: 'fishing',
        wager: 0,
        payout: caught.reward,
        won: true,
        actionId: message.id || `${userId}:${currentTime.getTime()}`,
        cooldownSeconds: NIGHTY_FISHING_COOLDOWN_SECONDS,
        ...periods,
        now: currentTime,
      })
      await safeReply(message, fishingPayload(caught, result))
      return { status: 'handled', command: 'fish', caught, result }
    }

    if (parsed.command === 'dungeon' || parsed.command === 'boss') {
      const collection = await store.getCollection({ guildId, userId })
      const strongest = collection
        .filter((item) => item.quantity > 0)
        .map((item) => NIGHTY_CHARACTER_BY_ID.get(item.characterId))
        .filter(Boolean)
        .sort((left, right) => right.power - left.power)[0]
      if (!strongest) {
        await safeReply(message, marketResultPayload('Nighty Raid Locked', 'Use `nighty hunt` to recruit a character before entering raids.'))
        return { status: 'handled', command: parsed.command, reason: 'empty_collection' }
      }
      const gameType = parsed.command
      const adventure = resolveNightyAdventure(strongest, gameType === 'dungeon' ? NIGHTY_DUNGEONS : NIGHTY_BOSSES, random)
      const result = await store.recordGameResult({
        guildId,
        userId,
        gameType,
        wager: 0,
        payout: adventure.reward,
        won: adventure.won,
        actionId: message.id || `${userId}:${currentTime.getTime()}`,
        cooldownSeconds: gameType === 'dungeon' ? NIGHTY_DUNGEON_COOLDOWN_SECONDS : NIGHTY_BOSS_COOLDOWN_SECONDS,
        ...periods,
        now: currentTime,
      })
      await safeReply(message, adventurePayload(gameType, adventure, result))
      return { status: 'handled', command: gameType, adventure, result }
    }

    if (parsed.command === 'word') {
      const guess = parsed.args.join(' ').trim().toLowerCase()
      if (guess) {
        const active = await store.getActiveGameSession({ guildId, userId, gameType: 'word', now: currentTime })
        if (!active) {
          await safeReply(message, marketResultPayload('Nighty Word Scramble', 'You do not have an active word. Start one with `nighty word`.'))
          return { status: 'handled', command: 'word', reason: 'no_active_game' }
        }
        const correct = guess === String(active.state.answer).toLowerCase()
        const session = await store.completeGameSession({
          sessionId: active.id,
          userId,
          state: active.state,
          outcome: correct ? 'correct' : 'incorrect',
          payout: correct ? NIGHTY_WORD_REWARD : 0,
          won: correct,
          ...periods,
          now: currentTime,
        })
        await safeReply(message, wordResultPayload(session, guess))
        return { status: 'handled', command: 'word_answer', session }
      }
      const word = createNightyWord(random)
      const session = await store.startGameSession({
        id: createGameId(),
        guildId,
        channelId: message.channelId || '',
        userId,
        gameType: 'word',
        wager: 0,
        state: word,
        expiresAt: new Date(currentTime.getTime() + NIGHTY_WORD_EXPIRY_SECONDS * 1000).toISOString(),
        now: currentTime,
      })
      await safeReply(message, wordPayload(session))
      return { status: 'handled', command: 'word', session }
    }

    if (parsed.command === 'pvp') {
      const opponentId = mentionedUserId(parsed.args[0])
      const wagerInput = parseNightyWager(parsed.args[1], ensured.player.balance)
      const wager = wagerInput?.amount || null
      if (!opponentId || !wager) {
        await safeReply(message, marketResultPayload('Nighty Shadow Duel', 'Usage: `nighty duel @player <wager|all> [character_id]`. Omit the character ID to use your strongest fighter.'))
        return { status: 'handled', command: 'pvp', reason: 'invalid_arguments' }
      }
      if (opponentId === userId) {
        await safeReply(message, marketResultPayload('Nighty PvP', 'You cannot challenge yourself.'))
        return { status: 'handled', command: 'pvp', reason: 'self_challenge' }
      }
      if (ensured.player.balance < wager) {
        await safeReply(message, marketResultPayload('Nighty PvP', `You need **${formatNightCurrency(wager)}** to create this challenge.`))
        return { status: 'handled', command: 'pvp', reason: 'insufficient_balance' }
      }
      const opponent = await store.getPlayer({ guildId, userId: opponentId })
      if (!opponent) {
        await safeReply(message, marketResultPayload('Nighty PvP', 'That player must create a Nighty profile first by typing `nighty balance`.'))
        return { status: 'handled', command: 'pvp', reason: 'missing_opponent' }
      }
      const [challengerCollection, opponentCollection] = await Promise.all([
        store.getCollection({ guildId, userId }),
        store.getCollection({ guildId, userId: opponentId }),
      ])
      const challengerChoices = strongestOwnedCharacters(challengerCollection, NIGHTY_CHARACTERS.length)
      const opponentChoices = strongestOwnedCharacters(opponentCollection, 4)
      const requestedCharacterId = String(parsed.args[2] || '').toLowerCase()
      const challengerCharacter = requestedCharacterId
        ? challengerChoices.find((character) => character.id === requestedCharacterId)
        : challengerChoices[0]
      if (!challengerCharacter || opponentChoices.length === 0) {
        const description = requestedCharacterId && challengerChoices.length > 0
          ? 'You do not own that fighter. Check IDs with `nighty collection`.'
          : 'Both players need at least one captured character before starting a Shadow Duel.'
        await safeReply(message, marketResultPayload('Nighty Shadow Duel Locked', description))
        return { status: 'handled', command: 'pvp', reason: 'missing_character' }
      }
      const session = await store.createPartySession({
        id: createGameId(),
        guildId,
        channelId: message.channelId || '',
        hostId: userId,
        gameType: 'shadow_duel',
        wager,
        state: {
          phase: 'lobby',
          baseWager: wager,
          opponentId,
          challengerCharacter,
          opponentChoices,
          allInPending: wagerInput.allIn,
        },
        status: 'lobby',
        expiresAt: new Date(currentTime.getTime() + NIGHTY_PVP_EXPIRY_SECONDS * 1000).toISOString(),
        now: currentTime,
      })
      if (session.mutationStatus === 'insufficient_balance') {
        await safeReply(message, marketResultPayload('Nighty Shadow Duel', `You do not have enough Night Currency. Balance: **${formatNightCurrency(session.balance)}**.`))
        return { status: 'handled', command: 'pvp', reason: 'insufficient_balance' }
      }
      await safeReply(message, session.state.allInPending
        ? allInConfirmationPayload(session, 'duel')
        : session.status === 'lobby' ? shadowDuelChallengePayload(session) : shadowDuelPayload(session))
      return { status: 'handled', command: 'pvp', session }
    }

    if (parsed.command === 'trade') {
      const buyerId = mentionedUserId(parsed.args[0])
      const characterId = String(parsed.args[1] || '').toLowerCase()
      const quantity = positiveQuantity(parsed.args[2])
      const price = parseNightAmount(parsed.args[3])
      const character = NIGHTY_CHARACTER_BY_ID.get(characterId)
      if (!buyerId || !character || !quantity || !price) {
        await safeReply(message, marketResultPayload('Nighty Private Trade', 'Usage: `nighty trade @player <character_id> <quantity> <total_price>`. Find IDs with `nighty collection`.'))
        return { status: 'handled', command: 'trade', reason: 'invalid_arguments' }
      }
      if (buyerId === userId) {
        await safeReply(message, marketResultPayload('Nighty Private Trade', 'You cannot trade with yourself.'))
        return { status: 'handled', command: 'trade', reason: 'self_trade' }
      }
      const buyer = await store.getPlayer({ guildId, userId: buyerId })
      if (!buyer) {
        await safeReply(message, marketResultPayload('Nighty Private Trade', 'That player must create a Nighty profile first by typing `nighty balance`.'))
        return { status: 'handled', command: 'trade', reason: 'missing_buyer' }
      }
      const collection = await store.getCollection({ guildId, userId })
      const owned = collection.find((item) => item.characterId === characterId)?.quantity || 0
      if (owned < quantity) {
        await safeReply(message, marketResultPayload('Nighty Private Trade', `You only own **${character.name} x${owned}**.`))
        return { status: 'handled', command: 'trade', reason: 'insufficient_inventory' }
      }
      const offer = await store.createTradeOffer({
        id: createId(),
        guildId: String(guildId),
        channelId: String(message.channelId || ''),
        sellerId: String(userId),
        buyerId,
        characterId,
        quantity,
        price,
        expiresAt: new Date(currentTime.getTime() + NIGHTY_TRADE_EXPIRY_SECONDS * 1000).toISOString(),
      })
      await safeReply(message, tradeOfferPayload(offer))
      return { status: 'handled', command: 'trade', offer }
    }

    if (parsed.command === 'market' || parsed.command === 'market_sell') {
      const subcommand = parsed.command === 'market_sell' ? 'sell' : parsed.args[0]?.toLowerCase()
      const offset = parsed.command === 'market_sell' ? 0 : 1
      if (subcommand === 'sell') {
        const characterId = String(parsed.args[offset] || '').toLowerCase()
        const quantity = positiveQuantity(parsed.args[offset + 1])
        const price = parseNightAmount(parsed.args[offset + 2])
        const character = NIGHTY_CHARACTER_BY_ID.get(characterId)
        if (!character || !quantity || !price) {
          await safeReply(message, marketResultPayload('Nighty Market', 'Usage: `nighty market sell <character_id> <quantity> <total_price>`.'))
          return { status: 'handled', command: 'market_sell', reason: 'invalid_arguments' }
        }
        const collection = await store.getCollection({ guildId, userId })
        const owned = collection.find((item) => item.characterId === characterId)?.quantity || 0
        if (owned < quantity) {
          await safeReply(message, marketResultPayload('Nighty Market', `You only own **${character.name} x${owned}**.`))
          return { status: 'handled', command: 'market_sell', reason: 'insufficient_inventory' }
        }
        const listing = await store.createMarketListing({
          id: createListingId(),
          guildId: String(guildId),
          sellerId: String(userId),
          characterId,
          quantity,
          price,
        })
        await safeReply(message, marketResultPayload('Nighty Listing Created', `Listing \`${listing.id}\`: **${character.name} x${quantity}** for **${formatNightCurrency(price)}**.`))
        return { status: 'handled', command: 'market_sell', listing }
      }
      if (subcommand === 'cancel') {
        const listingId = String(parsed.args[1] || '').toLowerCase()
        const result = await store.cancelMarketListing({ listingId, sellerId: userId, now: currentTime })
        const description = result.status === 'cancelled'
          ? `Listing \`${listingId}\` was cancelled and its characters returned to your collection.`
          : 'That active listing was not found or does not belong to you.'
        await safeReply(message, marketResultPayload('Nighty Market', description))
        return { status: 'handled', command: 'market_cancel', result }
      }
      const listings = await store.listMarket({ guildId, limit: 10 })
      await safeReply(message, marketPayload(listings))
      return { status: 'handled', command: 'market', listings }
    }

    if (parsed.command === 'buy') {
      const listingId = String(parsed.args[0] || '').toLowerCase()
      if (!listingId) {
        await safeReply(message, marketResultPayload('Nighty Market', 'Usage: `nighty buy <listing_id>`.'))
        return { status: 'handled', command: 'buy', reason: 'missing_listing' }
      }
      const result = await store.buyMarketListing({ listingId, buyerId: userId, now: currentTime })
      const character = NIGHTY_CHARACTER_BY_ID.get(result.characterId)
      const descriptions = {
        sold: `Bought **${character?.name || result.characterId} x${result.quantity}** for **${formatNightCurrency(result.price)}**.`,
        forbidden: 'You cannot buy your own market listing.',
        cancelled: 'You no longer have enough Night Currency for this listing.',
        missing: 'That market listing does not exist.',
        active: 'That listing is no longer available.',
      }
      await safeReply(message, marketResultPayload(result.status === 'sold' ? 'Nighty Purchase Complete' : 'Nighty Purchase Failed', descriptions[result.status] || 'That listing is no longer available.'))
      return { status: 'handled', command: 'buy', result }
    }

    if (parsed.command === 'missions') {
      if (parsed.args[0]?.toLowerCase() === 'claim') {
        parsed.command = 'claim'
        parsed.args.shift()
      } else {
        const progress = await store.getMissionProgress({ guildId, userId, ...periods })
        await safeReply(message, missionsPayload(periods, progress))
        return { status: 'handled', command: 'missions', progress }
      }
    }

    if (parsed.command === 'claim') {
      const requested = String(parsed.args[0] || '').toLowerCase().replace(/-/g, '_')
      if (!requested) {
        await safeReply(message, unknownPayload('claim without a mission ID'))
        return { status: 'handled', command: 'claim', reason: 'missing_mission' }
      }
      const missions = requested === 'all'
        ? NIGHTY_MISSIONS
        : [NIGHTY_MISSION_BY_ID.get(requested)].filter(Boolean)
      if (missions.length === 0) {
        await safeReply(message, unknownPayload(`claim ${requested}`))
        return { status: 'handled', command: 'claim', reason: 'unknown_mission' }
      }
      const results = []
      for (const mission of missions) {
        const result = await store.claimMission({
          guildId,
          userId,
          periodKey: missionPeriodKey(mission, periods),
          mission,
        })
        results.push({ mission, result })
      }
      if (requested === 'all') {
        const claimed = results.filter((item) => item.result.status === 'claimed')
        const total = claimed.reduce((sum, item) => sum + item.result.reward, 0)
        const payload = claimed.length > 0
          ? { embeds: [baseEmbed('Nighty Mission Rewards', `Claimed ${claimed.length} mission reward${claimed.length === 1 ? '' : 's'} for **${formatNightCurrency(total)}**.`)] }
          : { embeds: [baseEmbed('No Mission Rewards Ready', 'Complete missions or check `nighty missions` for your progress.')] }
        await safeReply(message, payload)
      } else {
        await safeReply(message, missionClaimPayload(results[0].mission, results[0].result))
      }
      return { status: 'handled', command: 'claim', results }
    }

    await safeReply(message, unknownPayload(parsed.command))
    return { status: 'handled', command: 'unknown' }
  }

  async function handleInteraction(interaction) {
    if (!interaction.isButton?.()) return { status: 'ignored' }
    const parsed = parseNightyButtonId(interaction.customId)
    const gameButton = parseNightyGameButtonId(interaction.customId)
    const partyButton = parseNightyPartyButtonId(interaction.customId)
    if (!parsed && !gameButton && !partyButton) return { status: 'ignored' }
    const actorId = interaction.user.id
    const currentTime = now()

    if (partyButton) {
      let session = await store.getPartySession(partyButton.id)
      if (!session) {
        await interaction.reply({ content: 'This Nighty game no longer exists.', flags: MessageFlags.Ephemeral })
        return { status: 'handled', reason: 'missing' }
      }
      const expectedGameType = partyButton.gameType === 'duel' ? 'shadow_duel' : partyButton.gameType
      if (session.gameType !== expectedGameType) {
        await interaction.reply({ content: 'This button does not belong to that Nighty game.', flags: MessageFlags.Ephemeral })
        return { status: 'handled', reason: 'invalid_game' }
      }
      if (session.status === 'expired') {
        await interaction.update({
          ...marketResultPayload('Nighty Game Expired', 'The session expired and every unsettled wager was refunded.'),
          components: [],
        })
        return { status: 'handled', reason: 'expired', session }
      }
      if (!['lobby', 'active'].includes(session.status)) {
        await interaction.reply({ content: 'This Nighty game was already closed.', flags: MessageFlags.Ephemeral })
        return { status: 'handled', reason: 'already_resolved' }
      }
      const periods = nightyPeriodKeys(currentTime, timeZone)
      if (new Date(session.expiresAt).getTime() <= currentTime.getTime()) {
        const expired = await store.cancelPartySession({
          sessionId: session.id,
          actorId,
          reason: 'expired',
          now: currentTime,
        })
        await interaction.update({
          ...marketResultPayload('Nighty Game Expired', 'The session expired and every unsettled wager was refunded.'),
          components: [],
        })
        return { status: 'handled', reason: 'expired', session: expired }
      }
      if (session.state.allInPending) {
        if (session.hostId !== actorId) {
          await interaction.reply({ content: 'The host must confirm this all-in wager first.', flags: MessageFlags.Ephemeral })
          return { status: 'handled', reason: 'awaiting_all_in_confirmation' }
        }
        if (partyButton.action === 'cancel_allin') {
          const cancelled = await store.cancelPartySession({ sessionId: session.id, actorId, reason: 'all_in_cancelled', now: currentTime })
          await interaction.update({ ...marketResultPayload('All-In Cancelled', 'Your complete wager was refunded.'), components: [] })
          return { status: 'handled', reason: 'all_in_cancelled', session: cancelled }
        }
        if (partyButton.action !== 'confirm_allin') {
          await interaction.reply({ content: 'Confirm or cancel the all-in wager before playing.', flags: MessageFlags.Ephemeral })
          return { status: 'handled', reason: 'awaiting_all_in_confirmation' }
        }
        const confirmed = await store.updatePartySession({
          sessionId: session.id,
          actorId,
          state: { ...session.state, allInPending: false },
          status: session.status,
          expectedVersion: session.version,
          now: currentTime,
        })
        const payload = partyButton.gameType === 'duel'
          ? shadowDuelChallengePayload(confirmed)
          : partyButton.gameType === 'mines'
            ? minesPayload(confirmed)
            : partyButton.gameType === 'crash'
              ? crashLobbyPayload(confirmed)
              : partyBlackjackLobbyPayload(confirmed)
        await interaction.update(payload)
        if (partyButton.gameType === 'duel' && interaction.followUp) {
          await interaction.followUp({
            content: `<@${confirmed.state.opponentId}>, your Shadow Duel challenge is ready.`,
            allowedMentions: { parse: [], users: [confirmed.state.opponentId] },
          })
        }
        return { status: 'handled', reason: 'all_in_confirmed', session: confirmed }
      }

      if (partyButton.gameType === 'mines') {
        if (session.hostId !== actorId) {
          await interaction.reply({ content: 'Only the player who started this Mines board can use it.', flags: MessageFlags.Ephemeral })
          return { status: 'handled', reason: 'forbidden' }
        }
        const participant = joinedPartyPlayers(session)[0]
        let state = session.state
        let payout = 0
        let outcome = null
        if (partyButton.action === 'cashout') {
          if (state.revealed.length === 0) {
            await interaction.reply({ content: 'Reveal at least one safe tile before cashing out.', flags: MessageFlags.Ephemeral })
            return { status: 'handled', reason: 'nothing_to_cashout' }
          }
          payout = nightyMinesPayout(participant.wager, state)
          state = { ...state, phase: 'cashed_out' }
          outcome = 'cashed_out'
        } else if (partyButton.action.startsWith('pick_')) {
          const picked = pickNightyMine(state, Number(partyButton.action.slice(5)))
          if (picked.outcome === 'invalid') {
            await interaction.reply({ content: 'That Mines tile cannot be selected.', flags: MessageFlags.Ephemeral })
            return { status: 'handled', reason: 'invalid_move' }
          }
          state = picked.state
          if (picked.outcome === 'mine') outcome = 'mine'
          if (picked.outcome === 'cleared') {
            outcome = 'cleared'
            payout = nightyMinesPayout(participant.wager, state)
          }
        } else {
          await interaction.reply({ content: 'Unknown Mines action.', flags: MessageFlags.Ephemeral })
          return { status: 'handled', reason: 'invalid_move' }
        }
        if (outcome) {
          const completed = await store.completePartySession({
            sessionId: session.id,
            actorId,
            state,
            outcome,
            payouts: [{ userId: actorId, payout, won: payout > participant.wager }],
            ...periods,
            now: currentTime,
          })
          await interaction.update(minesPayload(completed))
          return { status: 'handled', type: 'mines', result: completed }
        }
        const updated = await store.updatePartySession({
          sessionId: session.id,
          actorId,
          state,
          status: 'active',
          expectedVersion: session.version,
          now: currentTime,
        })
        if (updated.mutationStatus === 'conflict') {
          await interaction.reply({ content: 'Another tile was processed first. Use the updated board.', flags: MessageFlags.Ephemeral })
          return { status: 'handled', reason: 'conflict' }
        }
        await interaction.update(minesPayload(updated))
        return { status: 'handled', type: 'mines', result: updated }
      }

      if (partyButton.gameType === 'duel') {
        if (session.status === 'lobby') {
          if (String(session.state.opponentId) !== actorId) {
            await interaction.reply({ content: 'Only the challenged player can answer this Shadow Duel.', flags: MessageFlags.Ephemeral })
            return { status: 'handled', reason: 'forbidden' }
          }
          if (partyButton.action === 'decline') {
            const cancelled = await store.cancelPartySession({ sessionId: session.id, actorId, reason: 'declined', now: currentTime })
            await interaction.update({ ...marketResultPayload('Shadow Duel Declined', 'The challenger’s wager was refunded.'), components: [] })
            return { status: 'handled', type: 'shadow_duel', result: cancelled }
          }
          const characterId = partyButton.action.startsWith('accept_') ? partyButton.action.slice(7) : ''
          const character = (session.state.opponentChoices || []).find((entry) => entry.id === characterId)
          if (!character) {
            await interaction.reply({ content: 'Choose one of the available fighters on this challenge.', flags: MessageFlags.Ephemeral })
            return { status: 'handled', reason: 'invalid_character' }
          }
          const joined = await store.joinPartySession({ sessionId: session.id, userId: actorId, now: currentTime })
          if (joined.mutationStatus === 'insufficient_balance') {
            await interaction.reply({ content: `You need ${formatNightCurrency(session.state.baseWager)} to accept.`, flags: MessageFlags.Ephemeral })
            return { status: 'handled', reason: 'insufficient_balance' }
          }
          if (joined.mutationStatus !== 'joined') {
            await interaction.reply({ content: 'This Shadow Duel could not be joined.', flags: MessageFlags.Ephemeral })
            return { status: 'handled', reason: joined.mutationStatus }
          }
          const state = createShadowDuelState(
            createShadowFighter(session.hostId, session.state.challengerCharacter),
            createShadowFighter(actorId, character),
            session.state.baseWager,
          )
          const active = await store.updatePartySession({
            sessionId: session.id,
            actorId,
            state,
            status: 'active',
            expectedVersion: joined.version,
            now: currentTime,
          })
          await interaction.update(shadowDuelPayload(active))
          return { status: 'handled', type: 'shadow_duel', result: active }
        }
        if (!joinedPartyPlayers(session).some((player) => player.userId === actorId)) {
          await interaction.reply({ content: 'Only the two duelists can choose a move.', flags: MessageFlags.Ephemeral })
          return { status: 'handled', reason: 'forbidden' }
        }
        const move = chooseShadowAction(session.state, actorId, partyButton.action)
        if (move.outcome === 'invalid' || move.outcome === 'skill_used') {
          const content = move.outcome === 'skill_used' ? 'Your fighter already used their Skill.' : 'Your move is already locked for this round.'
          await interaction.reply({ content, flags: MessageFlags.Ephemeral })
          return { status: 'handled', reason: move.outcome }
        }
        if (move.state.phase === 'completed') {
          const payouts = joinedPartyPlayers(session).map((player) => ({
            userId: player.userId,
            payout: move.state.tied ? player.wager : move.state.winnerId === player.userId ? player.wager * 2 : 0,
            won: move.state.winnerId === player.userId,
          }))
          const completed = await store.completePartySession({
            sessionId: session.id,
            actorId,
            state: move.state,
            outcome: move.state.tied ? 'tie' : 'completed',
            payouts,
            ...periods,
            now: currentTime,
          })
          await interaction.update(shadowDuelPayload(completed))
          return { status: 'handled', type: 'shadow_duel', result: completed }
        }
        const updated = await store.updatePartySession({
          sessionId: session.id,
          actorId,
          state: move.state,
          status: 'active',
          expectedVersion: session.version,
          now: currentTime,
        })
        if (updated.mutationStatus === 'conflict') {
          await interaction.reply({ content: 'The duel advanced before this click arrived. Choose again on the updated round.', flags: MessageFlags.Ephemeral })
          return { status: 'handled', reason: 'conflict' }
        }
        await interaction.update(shadowDuelPayload(updated))
        return { status: 'handled', type: 'shadow_duel', result: updated }
      }

      if (partyButton.gameType === 'crash') {
        if (session.status === 'lobby') {
          if (partyButton.action === 'join') {
            const joined = await store.joinPartySession({ sessionId: session.id, userId: actorId, now: currentTime })
            if (joined.mutationStatus === 'insufficient_balance') {
              await interaction.reply({ content: `You need ${formatNightCurrency(session.state.baseWager)} to join.`, flags: MessageFlags.Ephemeral })
              return { status: 'handled', reason: 'insufficient_balance' }
            }
            if (!['joined'].includes(joined.mutationStatus)) {
              await interaction.reply({ content: `You cannot join this lobby (${joined.mutationStatus}).`, flags: MessageFlags.Ephemeral })
              return { status: 'handled', reason: joined.mutationStatus }
            }
            await interaction.update(crashLobbyPayload(joined))
            return { status: 'handled', type: 'crash', result: joined }
          }
          if (partyButton.action === 'leave') {
            const left = await store.leavePartySession({ sessionId: session.id, userId: actorId, now: currentTime })
            if (left.mutationStatus !== 'left') {
              await interaction.reply({ content: 'The host must cancel the lobby; other joined players can leave.', flags: MessageFlags.Ephemeral })
              return { status: 'handled', reason: left.mutationStatus }
            }
            await interaction.update(crashLobbyPayload(left))
            return { status: 'handled', type: 'crash', result: left }
          }
          if (partyButton.action === 'cancel') {
            if (session.hostId !== actorId) {
              await interaction.reply({ content: 'Only the host can cancel this lobby.', flags: MessageFlags.Ephemeral })
              return { status: 'handled', reason: 'forbidden' }
            }
            const cancelled = await store.cancelPartySession({ sessionId: session.id, actorId, reason: 'cancelled', now: currentTime })
            await interaction.update({ ...marketResultPayload('Nightfall Crash Cancelled', 'Every joined player was refunded.'), components: [] })
            return { status: 'handled', type: 'crash', result: cancelled }
          }
          if (partyButton.action === 'start') {
            if (session.hostId !== actorId) {
              await interaction.reply({ content: 'Only the host can start this round.', flags: MessageFlags.Ephemeral })
              return { status: 'handled', reason: 'forbidden' }
            }
            const state = startNightyCrash(session.state, joinedPartyPlayers(session).map((player) => player.userId))
            const active = await store.updatePartySession({
              sessionId: session.id,
              actorId,
              state,
              status: 'active',
              expectedVersion: session.version,
              now: currentTime,
            })
            await interaction.update(crashPayload(active))
            return { status: 'handled', type: 'crash', result: active }
          }
        }
        const participant = joinedPartyPlayers(session).find((player) => player.userId === actorId)
        if (!participant || session.state.players?.[actorId]?.status !== 'riding') {
          await interaction.reply({ content: 'Only a player still riding can use this action.', flags: MessageFlags.Ephemeral })
          return { status: 'handled', reason: 'forbidden' }
        }
        const result = partyButton.action === 'push'
          ? advanceNightyCrash(session.state)
          : partyButton.action === 'cashout'
            ? cashOutNightyCrash(session.state, actorId, participant.wager)
            : { state: session.state, outcome: 'invalid' }
        if (result.outcome === 'invalid') {
          await interaction.reply({ content: 'That Crash action is unavailable.', flags: MessageFlags.Ephemeral })
          return { status: 'handled', reason: 'invalid_move' }
        }
        if (result.state.phase === 'crashed' || result.state.phase === 'completed') {
          const payouts = joinedPartyPlayers(session).map((player) => {
            const gamePlayer = result.state.players[player.userId]
            const payout = gamePlayer?.status === 'cashed_out' ? gamePlayer.payout : 0
            return { userId: player.userId, payout, won: payout > player.wager }
          })
          const completed = await store.completePartySession({
            sessionId: session.id,
            actorId,
            state: result.state,
            outcome: result.state.phase,
            payouts,
            ...periods,
            now: currentTime,
          })
          await interaction.update(crashPayload(completed))
          return { status: 'handled', type: 'crash', result: completed }
        }
        const updated = await store.updatePartySession({
          sessionId: session.id,
          actorId,
          state: result.state,
          status: 'active',
          expectedVersion: session.version,
          now: currentTime,
        })
        if (updated.mutationStatus === 'conflict') {
          await interaction.reply({ content: 'Another Crash action landed first. Use the updated round.', flags: MessageFlags.Ephemeral })
          return { status: 'handled', reason: 'conflict' }
        }
        await interaction.update(crashPayload(updated))
        return { status: 'handled', type: 'crash', result: updated }
      }

      if (partyButton.gameType === 'blackjack_multi') {
        if (session.status === 'lobby') {
          if (partyButton.action === 'join') {
            const joined = await store.joinPartySession({ sessionId: session.id, userId: actorId, now: currentTime })
            if (joined.mutationStatus === 'insufficient_balance') {
              await interaction.reply({ content: `You need ${formatNightCurrency(session.state.baseWager)} to join.`, flags: MessageFlags.Ephemeral })
              return { status: 'handled', reason: 'insufficient_balance' }
            }
            if (joined.mutationStatus !== 'joined') {
              await interaction.reply({ content: `You cannot join this table (${joined.mutationStatus}).`, flags: MessageFlags.Ephemeral })
              return { status: 'handled', reason: joined.mutationStatus }
            }
            await interaction.update(partyBlackjackLobbyPayload(joined))
            return { status: 'handled', type: 'blackjack_multi', result: joined }
          }
          if (partyButton.action === 'leave') {
            const left = await store.leavePartySession({ sessionId: session.id, userId: actorId, now: currentTime })
            if (left.mutationStatus !== 'left') {
              await interaction.reply({ content: 'The host must cancel the table; other joined players can leave.', flags: MessageFlags.Ephemeral })
              return { status: 'handled', reason: left.mutationStatus }
            }
            await interaction.update(partyBlackjackLobbyPayload(left))
            return { status: 'handled', type: 'blackjack_multi', result: left }
          }
          if (partyButton.action === 'cancel') {
            if (session.hostId !== actorId) {
              await interaction.reply({ content: 'Only the host can cancel this table.', flags: MessageFlags.Ephemeral })
              return { status: 'handled', reason: 'forbidden' }
            }
            const cancelled = await store.cancelPartySession({ sessionId: session.id, actorId, reason: 'cancelled', now: currentTime })
            await interaction.update({ ...marketResultPayload('Blackjack Table Cancelled', 'Every joined player was refunded.'), components: [] })
            return { status: 'handled', type: 'blackjack_multi', result: cancelled }
          }
          if (partyButton.action === 'deal') {
            if (session.hostId !== actorId) {
              await interaction.reply({ content: 'Only the host can deal the cards.', flags: MessageFlags.Ephemeral })
              return { status: 'handled', reason: 'forbidden' }
            }
            const state = startPartyBlackjack(session.state.baseWager, joinedPartyPlayers(session), random)
            if (state.phase === 'dealer') {
              const finished = finishPartyBlackjack(state)
              const completed = await store.completePartySession({
                sessionId: session.id,
                actorId,
                state: finished.state,
                outcome: 'completed',
                payouts: finished.payouts,
                ...periods,
                now: currentTime,
              })
              await interaction.update(partyBlackjackPayload(completed))
              return { status: 'handled', type: 'blackjack_multi', result: completed }
            }
            const active = await store.updatePartySession({
              sessionId: session.id,
              actorId,
              state,
              status: 'active',
              expectedVersion: session.version,
              now: currentTime,
            })
            await interaction.update(partyBlackjackPayload(active))
            return { status: 'handled', type: 'blackjack_multi', result: active }
          }
        }
        if (session.state.currentUserId !== actorId) {
          await interaction.reply({ content: `It is <@${session.state.currentUserId}>’s turn.`, flags: MessageFlags.Ephemeral })
          return { status: 'handled', reason: 'wrong_turn' }
        }
        const cost = partyBlackjackActionCost(session.state, actorId, partyButton.action)
        if (cost === null) {
          await interaction.reply({ content: 'That Blackjack action is not available for this hand.', flags: MessageFlags.Ephemeral })
          return { status: 'handled', reason: 'invalid_move' }
        }
        if (cost > 0) {
          const wagered = await store.addPartyWager({
            sessionId: session.id,
            userId: actorId,
            amount: cost,
            actionId: interaction.id || `${session.id}:${actorId}:${currentTime.getTime()}`,
            now: currentTime,
          })
          if (wagered.mutationStatus === 'insufficient_balance') {
            await interaction.reply({ content: `You need another ${formatNightCurrency(cost)} for that action.`, flags: MessageFlags.Ephemeral })
            return { status: 'handled', reason: 'insufficient_balance' }
          }
          if (!['added', 'duplicate'].includes(wagered.mutationStatus)) {
            await interaction.reply({ content: 'The additional Blackjack wager could not be locked.', flags: MessageFlags.Ephemeral })
            return { status: 'handled', reason: wagered.mutationStatus }
          }
          session = wagered
        }
        const played = playPartyBlackjack(session.state, actorId, partyButton.action)
        if (played.state.phase === 'dealer') {
          const finished = finishPartyBlackjack(played.state)
          const completed = await store.completePartySession({
            sessionId: session.id,
            actorId,
            state: finished.state,
            outcome: 'completed',
            payouts: finished.payouts,
            ...periods,
            now: currentTime,
          })
          await interaction.update(partyBlackjackPayload(completed))
          return { status: 'handled', type: 'blackjack_multi', result: completed }
        }
        const updated = await store.updatePartySession({
          sessionId: session.id,
          actorId,
          state: played.state,
          status: 'active',
          expectedVersion: session.version,
          now: currentTime,
        })
        if (updated.mutationStatus === 'conflict') {
          await interaction.reply({ content: 'The table advanced before this click arrived. Use the updated hand.', flags: MessageFlags.Ephemeral })
          return { status: 'handled', reason: 'conflict' }
        }
        await interaction.update(partyBlackjackPayload(updated))
        return { status: 'handled', type: 'blackjack_multi', result: updated }
      }
    }

    if (gameButton) {
      const session = await store.getGameSession(gameButton.id)
      if (!session) {
        await interaction.reply({ content: 'This Nighty game no longer exists.', flags: MessageFlags.Ephemeral })
        return { status: 'handled', reason: 'missing' }
      }
      if (session.userId !== actorId) {
        await interaction.reply({ content: 'Only the player who started this Nighty game can use these buttons.', flags: MessageFlags.Ephemeral })
        return { status: 'handled', reason: 'forbidden' }
      }
      if (session.gameType !== gameButton.gameType) {
        await interaction.reply({ content: 'This button does not belong to that Nighty game.', flags: MessageFlags.Ephemeral })
        return { status: 'handled', reason: 'invalid_game' }
      }
      if (session.status !== 'active') {
        await interaction.reply({ content: 'This Nighty game was already completed.', flags: MessageFlags.Ephemeral })
        return { status: 'handled', reason: 'already_resolved' }
      }
      const periods = nightyPeriodKeys(currentTime, timeZone)
      if (new Date(session.expiresAt).getTime() <= currentTime.getTime()) {
        const expired = await store.completeGameSession({
          sessionId: session.id,
          userId: actorId,
          state: session.state,
          outcome: 'expired',
          payout: 0,
          won: false,
          ...periods,
          now: currentTime,
        })
        await interaction.update({ ...marketResultPayload('Nighty Game Expired', 'This game expired before an answer was submitted.'), components: [] })
        return { status: 'handled', reason: 'expired', session: expired }
      }

      if (gameButton.gameType === 'blackjack') {
        let state = session.state
        if (gameButton.action === 'hit') {
          state = hitBlackjack(state)
          if (blackjackHandValue(state.player) < 21) {
            const updated = await store.updateGameSession({ sessionId: session.id, userId: actorId, state, now: currentTime })
            await interaction.update(blackjackPayload(updated))
            return { status: 'handled', type: 'blackjack', result: updated }
          }
        }
        const resolved = finishBlackjack(state)
        const payout = blackjackPayout(session.wager, resolved.multiplier)
        const completed = await store.completeGameSession({
          sessionId: session.id,
          userId: actorId,
          state: resolved.state,
          outcome: resolved.outcome,
          payout,
          won: resolved.won,
          ...periods,
          now: currentTime,
        })
        await interaction.update(blackjackPayload(completed, completed))
        return { status: 'handled', type: 'blackjack', result: completed }
      }

      const selectedIndex = Number(gameButton.action.slice('answer_'.length))
      const correct = selectedIndex === Number(session.state.correctIndex)
      const completed = await store.completeGameSession({
        sessionId: session.id,
        userId: actorId,
        state: session.state,
        outcome: correct ? 'correct' : 'incorrect',
        payout: correct ? NIGHTY_TRIVIA_REWARD : 0,
        won: correct,
        ...periods,
        now: currentTime,
      })
      await interaction.update(triviaResultPayload(completed, selectedIndex))
      return { status: 'handled', type: 'trivia', result: completed }
    }

    if (parsed.type === 'pvp') {
      const challenge = await store.getPvpChallenge(parsed.id)
      if (!challenge) {
        await interaction.reply({ content: 'This Nighty PvP challenge no longer exists.', flags: MessageFlags.Ephemeral })
        return { status: 'handled', reason: 'missing' }
      }
      if (challenge.opponentId !== actorId) {
        await interaction.reply({ content: 'Only the challenged player can accept or decline this PvP battle.', flags: MessageFlags.Ephemeral })
        return { status: 'handled', reason: 'forbidden' }
      }
      const winnerId = parsed.action === 'accept'
        ? (Number(random()) < 0.5 ? challenge.challengerId : challenge.opponentId)
        : null
      const result = await store.resolvePvpChallenge({
        challengeId: parsed.id,
        actorId,
        action: parsed.action,
        winnerId,
        now: currentTime,
      })
      await interaction.update(pvpResolvedPayload(result))
      return { status: 'handled', type: 'pvp', result }
    }

    const offer = await store.getTradeOffer(parsed.id)
    if (!offer) {
      await interaction.reply({ content: 'This Nighty trade no longer exists.', flags: MessageFlags.Ephemeral })
      return { status: 'handled', reason: 'missing' }
    }
    if (offer.buyerId !== actorId) {
      await interaction.reply({ content: 'Only the selected buyer can accept or decline this trade.', flags: MessageFlags.Ephemeral })
      return { status: 'handled', reason: 'forbidden' }
    }
    const result = await store.resolveTradeOffer({
      offerId: parsed.id,
      actorId,
      action: parsed.action,
      now: currentTime,
    })
    await interaction.update(tradeResolvedPayload(result))
    return { status: 'handled', type: 'trade', result }
  }

  return { initialize, refundExpiredPartySessions, handleMessage, handleInteraction, store }
}

export function installNightyWorkflow(client, options = {}) {
  const workflow = createNightyWorkflow(options)
  let expirationSweep = null
  client.on(Events.MessageCreate, (message) => {
    workflow.handleMessage(message).catch(async (reason) => {
      options.errorReporter?.report('nighty_message_command', reason)
      console.error('Nighty command failed:', reason instanceof Error ? reason.message : reason)
      if (!message.author?.bot) {
        await safeReply(message, {
          embeds: [baseEmbed('Nighty Is Unavailable', 'The game could not access its saved data. Please try again shortly.')],
        }).catch(() => undefined)
      }
    })
  })
  client.on(Events.InteractionCreate, (interaction) => {
    workflow.handleInteraction(interaction).catch(async (reason) => {
      options.errorReporter?.report('nighty_button_interaction', reason)
      console.error('Nighty button failed:', reason instanceof Error ? reason.message : reason)
      const payload = { content: 'The Nighty action could not be completed.', flags: MessageFlags.Ephemeral }
      if (interaction.replied || interaction.deferred) await interaction.editReply(payload).catch(() => undefined)
      else await interaction.reply(payload).catch(() => undefined)
    })
  })
  client.once(Events.ClientReady, () => {
    workflow.initialize().catch((reason) => {
      options.errorReporter?.report('nighty_initialize', reason)
      console.error('Nighty storage failed to initialize:', reason instanceof Error ? reason.message : reason)
    })
    expirationSweep = setInterval(() => {
      workflow.refundExpiredPartySessions().catch((reason) => {
        options.errorReporter?.report('nighty_party_expiration_sweep', reason)
        console.error('Nighty expiration sweep failed:', reason instanceof Error ? reason.message : reason)
      })
    }, options.partySweepIntervalMs || 60_000)
    expirationSweep.unref?.()
  })
  workflow.stopExpirationSweep = () => {
    if (expirationSweep) clearInterval(expirationSweep)
    expirationSweep = null
  }
  return workflow
}
