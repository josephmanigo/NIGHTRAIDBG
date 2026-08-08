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
  slot: 'slots',
  coin: 'coinflip',
  flip: 'coinflip',
  bj: 'blackjack',
  fishing: 'fish',
  raid: 'dungeon',
  dungeons: 'dungeon',
  bossfight: 'boss',
  words: 'word',
  games: 'game_help',
})

const BUTTON_PATTERN = /^nighty:(pvp|trade):(accept|decline):([a-f0-9-]{8,64})$/i
const GAME_BUTTON_PATTERN = /^nighty:(blackjack|trivia):(hit|stand|answer_[0-3]):([a-f0-9-]{8,64})$/i

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
    { name: 'PvP', value: '`nighty pvp @player <wager>` · the challenged player must accept' },
    { name: 'Trading', value: '`nighty trade @player <character_id> <quantity> <total_price>`' },
    { name: 'Market', value: '`nighty market` · `nighty market sell <character_id> <quantity> <price>` · `nighty buy <listing_id>`' },
    { name: 'Missions', value: '`nighty missions` · `nighty claim <mission_id>` · `nighty claim all`' },
    { name: 'Casino', value: '`nighty slots <bet>` · `nighty coinflip <heads|tails> <bet>` · `nighty blackjack <bet>`' },
    { name: 'Quick games', value: '`nighty trivia` · `nighty fish` · `nighty word` · `nighty word <answer>`' },
    { name: 'Raids', value: '`nighty dungeon` · `nighty boss`' },
    { name: 'Game records', value: '`nighty stats` · wagers accept `1000`, `1,000`, `100k`, or `1m`' },
    { name: 'Rankings', value: '`nighty leaderboard` · `nighty games`' },
  )
  return withArt(embed)
}

function gameHelpPayload() {
  const embed = baseEmbed('Nighty Games', 'Eight persistent games share your Night Currency balance, missions, records, and duplicate-safe settlement.')
    .addFields(
      { name: 'Casino', value: '`nighty slots <bet>`\n`nighty coinflip <heads|tails> <bet>`\n`nighty blackjack <bet>`' },
      { name: 'Knowledge & collection', value: '`nighty trivia`\n`nighty word` then `nighty word <answer>`\n`nighty fish`' },
      { name: 'Raids', value: '`nighty dungeon`\n`nighty boss`\nBoth use your strongest owned character.' },
      { name: 'Limits', value: `Casino bets: ${formatNightCurrency(NIGHTY_MIN_BET)}–${formatNightCurrency(NIGHTY_MAX_BET)}.` },
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
      ? `**${character.name}** · ${character.rarity} · x${item.quantity}`
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
    new ButtonBuilder().setCustomId(`nighty:blackjack:hit:${id}`).setLabel('Hit').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`nighty:blackjack:stand:${id}`).setLabel('Stand').setStyle(ButtonStyle.Secondary),
  )]
}

function blackjackPayload(session, resolved = null) {
  const state = resolved?.state || session.state
  const playerValue = blackjackHandValue(state.player)
  const dealerValue = blackjackHandValue(state.dealer)
  const active = !resolved && session.status === 'active'
  const dealerCards = active ? `${state.dealer[0]}  🂠` : state.dealer.join('  ')
  const description = active
    ? `Your wager of **${formatNightCurrency(session.wager)}** is escrowed. Choose Hit or Stand.`
    : `Result: **${String(resolved?.outcome || session.outcome || session.status).toUpperCase()}**.`
  const embed = baseEmbed(active ? 'Nighty Blackjack' : 'Nighty Blackjack Result', description)
    .addFields(
      { name: `Your hand · ${playerValue}`, value: state.player.join('  '), inline: false },
      { name: active ? 'Dealer · ?' : `Dealer · ${dealerValue}`, value: dealerCards, inline: false },
    )
  if (!active) {
    embed.addFields(
      { name: 'Payout', value: formatNightCurrency(resolved?.payout || session.payout || 0), inline: true },
      { name: 'Balance', value: formatNightCurrency(resolved?.balance || session.balance || 0), inline: true },
    )
  }
  return { embeds: [embed], components: active ? blackjackButtons(session.id) : [] }
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
      const wager = parseNightAmount(parsed.args[0])
      if (!validNightyBet(wager)) {
        await safeReply(message, marketResultPayload('Nighty Slots', `Usage: \`nighty slots <bet>\`. Bets must be between **${formatNightCurrency(NIGHTY_MIN_BET)}** and **${formatNightCurrency(NIGHTY_MAX_BET)}**.`))
        return { status: 'handled', command: 'slots', reason: 'invalid_bet' }
      }
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
      const wager = parseNightAmount(choice === first ? parsed.args[1] : parsed.args[0])
      if (!choice || !validNightyBet(wager)) {
        await safeReply(message, marketResultPayload('Nighty Coin Flip', `Usage: \`nighty coinflip <heads|tails> <bet>\`. Bets must be between **${formatNightCurrency(NIGHTY_MIN_BET)}** and **${formatNightCurrency(NIGHTY_MAX_BET)}**.`))
        return { status: 'handled', command: 'coinflip', reason: 'invalid_arguments' }
      }
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

    if (parsed.command === 'blackjack') {
      const wager = parseNightAmount(parsed.args[0])
      if (!validNightyBet(wager)) {
        await safeReply(message, marketResultPayload('Nighty Blackjack', `Usage: \`nighty blackjack <bet>\`. Bets must be between **${formatNightCurrency(NIGHTY_MIN_BET)}** and **${formatNightCurrency(NIGHTY_MAX_BET)}**.`))
        return { status: 'handled', command: 'blackjack', reason: 'invalid_bet' }
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
      const wager = parseNightAmount(parsed.args[1])
      if (!opponentId || !wager) {
        await safeReply(message, marketResultPayload('Nighty PvP', 'Usage: `nighty pvp @player <wager>` — for example `nighty pvp @player 100k`.'))
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
      const challenge = await store.createPvpChallenge({
        id: createId(),
        guildId: String(guildId),
        channelId: String(message.channelId || ''),
        challengerId: String(userId),
        opponentId,
        wager,
        expiresAt: new Date(currentTime.getTime() + NIGHTY_PVP_EXPIRY_SECONDS * 1000).toISOString(),
      })
      await safeReply(message, pvpChallengePayload(challenge))
      return { status: 'handled', command: 'pvp', challenge }
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
    if (!parsed && !gameButton) return { status: 'ignored' }
    const actorId = interaction.user.id
    const currentTime = now()

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

  return { initialize, handleMessage, handleInteraction, store }
}

export function installNightyWorkflow(client, options = {}) {
  const workflow = createNightyWorkflow(options)
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
  })
  return workflow
}
