export const BOT_MODULES = [
  { id: 'rules', name: 'Rules', description: 'Official server, clan, and scrim rules.' },
  { id: 'announcements', name: 'Announcements', description: 'Administrator announcement tools.' },
  { id: 'minigames', name: 'Minigames', description: 'Guessing games and game controls.' },
  { id: 'leaderboards', name: 'Winners', description: 'Winner claims and leaderboards.' },
  { id: 'music', name: 'Music', description: 'Voice music playback and queue controls.' },
  { id: 'watchparty', name: 'Watch party', description: 'Scheduled movie watch parties.' },
  { id: 'live_tools', name: 'Live tools', description: 'Manual live and upload announcements.' },
  { id: 'social_tracker', name: 'TikTok tracker', description: 'Live and upload tracking management.' },
  { id: 'scoreboard', name: 'Scoreboard', description: 'Tournament processing and score administration.' },
] as const

export type BotModuleId = (typeof BOT_MODULES)[number]['id']

export const BOT_COMMANDS = [
  { name: 'rules', description: 'Show the official NIGHTRAID rules.', module: 'rules' },
  { name: 'nrules', description: 'Show the NIGHTRAID clan rules.', module: 'rules' },
  { name: 'scrimrules', description: 'Show the official NIGHTRAID scrim mechanics.', module: 'rules' },
  { name: 'announce', description: 'Post a NIGHTRAID announcement.', module: 'announcements' },
  { name: 'guessthenumber', description: 'Start a guess-the-number game.', module: 'minigames' },
  { name: 'guesstheword', description: 'Start a guess-the-word game.', module: 'minigames' },
  { name: 'guesstheemoji', description: 'Start a guess-the-emoji game.', module: 'minigames' },
  { name: 'endgame', description: 'End the guessing game in this channel.', module: 'minigames' },
  { name: 'winner', description: 'Fetch today\'s minigame winners.', module: 'leaderboards' },
  { name: 'leaderboard', description: 'Show the minigame winner leaderboard.', module: 'leaderboards' },
  { name: 'nrtleaderboard', description: 'Show the NRT leaderboard.', module: 'leaderboards' },
  { name: 'addnrt', description: 'Add NRT to a user.', module: 'leaderboards' },
  { name: 'minusnrt', description: 'Subtract NRT from a user.', module: 'leaderboards' },
  { name: 'music', description: 'Play music in your voice channel.', module: 'music' },
  { name: 'skip', description: 'Skip the currently playing track.', module: 'music' },
  { name: 'stop', description: 'Stop playback and leave voice.', module: 'music' },
  { name: 'queue', description: 'Show the current music queue.', module: 'music' },
  { name: 'watchparty', description: 'Create or schedule a movie watch party.', module: 'watchparty' },
  { name: 'live', description: 'Manually announce a live stream or video.', module: 'live_tools' },
  { name: 'track', description: 'Track a TikTok creator.', module: 'social_tracker' },
  { name: 'untrack', description: 'Stop tracking a creator.', module: 'social_tracker' },
  { name: 'tracked', description: 'Show all tracked creators.', module: 'social_tracker' },
  { name: 'track-edit', description: 'Edit a tracked creator.', module: 'social_tracker' },
  { name: 'track-check', description: 'Check a creator immediately.', module: 'social_tracker' },
  { name: 'tracker-status', description: 'Show tracker diagnostics.', module: 'social_tracker' },
  { name: 'generate-mvp', description: 'Generate the tournament MVP table.', module: 'scoreboard' },
  { name: 'health', description: 'Check game-results services.', module: 'scoreboard' },
  { name: 'processgame', description: 'Process the latest screenshot submission.', module: 'scoreboard' },
  { name: 'refreshteams', description: 'Reload registered tournament teams.', module: 'scoreboard' },
  { name: 'correctscore', description: 'Correct a score in the latest round.', module: 'scoreboard' },
  { name: 'standings', description: 'Display the current ranking.', module: 'scoreboard' },
  { name: 'clear', description: 'Clear all four score rounds.', module: 'scoreboard' },
  { name: 'edit-round', description: 'Edit a confirmed round.', module: 'scoreboard' },
  { name: 'delete-round', description: 'Logically delete a confirmed round.', module: 'scoreboard' },
  { name: 'restore-round', description: 'Restore a deleted round.', module: 'scoreboard' },
  { name: 'reprocess-round', description: 'Re-read a round\'s screenshots.', module: 'scoreboard' },
  { name: 'rollback-update', description: 'Restore the latest update backup.', module: 'scoreboard' },
  { name: 'sync-score-sheet', description: 'Sync a round to the production sheet.', module: 'scoreboard' },
] as const satisfies ReadonlyArray<{
  name: string
  description: string
  module: BotModuleId
}>

export const BOT_COMMAND_NAMES = new Set<string>(BOT_COMMANDS.map((command) => command.name))

export const DEFAULT_MODULE_SETTINGS = Object.freeze(
  Object.fromEntries(BOT_MODULES.map((module) => [module.id, true])) as Record<BotModuleId, boolean>,
)

export function normalizeModuleSettings(value: unknown): Record<BotModuleId, boolean> {
  const input = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  return Object.fromEntries(
    BOT_MODULES.map((module) => [module.id, input[module.id] !== false]),
  ) as Record<BotModuleId, boolean>
}
