/*
 * NIGHTRAID name format for the change-name channel.
 *
 * The channel's pinned format:
 *
 *   OTHER CLAN MEMBERS & HANDLER
 *     MRG • MIMAI | BS
 *     SS • KULIT | FL
 *     SS • KULIT - BS HANDLER/REP
 *
 *   FOR NIGHTRAID MEMBERS
 *     NIGHT • Ems
 *
 * So every request is `TAG • NAME`, and everyone outside NIGHTRAID also
 * states their game (`| BS`) or their handler/rep role (`- BS HANDLER/REP`).
 * Spacing and bullet look-alikes are normalised instead of rejected; anything
 * that misses a required part is rejected so the bot can react ❌.
 */

export const NIGHTRAID_TAG = 'NIGHT'
export const NICKNAME_MAX_LENGTH = 32 // Discord's hard limit.

const BULLET = '•'
const BULLET_VARIANTS = /[•·∙⦁●・]/g
const TAG_PATTERN = /^[A-Z0-9]{1,10}$/
const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} '._-]*$/u
const GAME_PATTERN = /^[A-Z0-9]{1,8}$/
const ROLE_PATTERN = /^(?:([A-Z0-9]{1,8}) )?(HANDLER\/REP|REP\/HANDLER|HANDLER|REP)$/

const invalid = (reason) => ({ ok: false, reason })

function collapse(value) {
  return value.replace(BULLET_VARIANTS, BULLET).replace(/\s+/g, ' ').trim()
}

function checkName(name) {
  if (!name) return 'the name is missing'
  if (!NAME_PATTERN.test(name)) return `"${name}" is not a usable name`
  return null
}

/* Returns { ok: true, nickname } with the canonical spacing, or
 * { ok: false, reason } explaining which part of the format is missing. */
export function formatNickname(rawValue) {
  const value = collapse(String(rawValue ?? ''))
  if (!value) return invalid('the message is empty')

  const bullets = value.split(BULLET)
  if (bullets.length === 1) return invalid(`the "${BULLET}" separator is missing`)
  if (bullets.length > 2) return invalid(`there is more than one "${BULLET}" separator`)

  const tag = bullets[0].trim().toUpperCase()
  const rest = bullets[1].trim()
  if (!tag) return invalid('the clan tag is missing')
  if (!TAG_PATTERN.test(tag)) return invalid(`"${tag}" is not a usable clan tag`)

  let nickname
  if (tag === NIGHTRAID_TAG) {
    if (rest.includes('|')) return invalid(`NIGHTRAID names are written as "${NIGHTRAID_TAG} ${BULLET} Name" without a game`)
    const nameProblem = checkName(rest)
    if (nameProblem) return invalid(nameProblem)
    nickname = `${NIGHTRAID_TAG} ${BULLET} ${rest}`
  } else if (rest.includes('|')) {
    const separator = rest.indexOf('|')
    const name = rest.slice(0, separator).trim()
    const game = rest.slice(separator + 1).trim().toUpperCase()
    const nameProblem = checkName(name)
    if (nameProblem) return invalid(nameProblem)
    if (!game) return invalid('the game is missing after "|"')
    if (!GAME_PATTERN.test(game)) return invalid(`"${game}" is not a usable game code`)
    nickname = `${tag} ${BULLET} ${name} | ${game}`
  } else if (rest.includes('-')) {
    /* The role is written last, so a hyphenated name still parses. */
    const separator = rest.lastIndexOf('-')
    const name = rest.slice(0, separator).trim()
    const role = rest.slice(separator + 1).trim().toUpperCase()
    const nameProblem = checkName(name)
    if (nameProblem) return invalid(nameProblem)
    const roleParts = ROLE_PATTERN.exec(role)
    if (!roleParts) return invalid(`"${role}" is not a usable role — write it as "GAME HANDLER", "GAME REP", or "GAME HANDLER/REP"`)
    nickname = `${tag} ${BULLET} ${name} - ${roleParts[1] ? `${roleParts[1]} ` : ''}${roleParts[2]}`
  } else {
    return invalid(`clans other than NIGHTRAID need "| GAME" or "- GAME HANDLER/REP" after the name`)
  }

  if (nickname.length > NICKNAME_MAX_LENGTH) {
    return invalid(`the name is ${nickname.length} characters and Discord allows only ${NICKNAME_MAX_LENGTH}`)
  }
  return { ok: true, nickname }
}
